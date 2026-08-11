import test from "node:test";
import assert from "node:assert/strict";
import type { CandidateProfile } from "../core/types.js";
import { buildWorkdayWidgetsFromControls, type WorkdayControlSnapshot, type WorkdayWidgetSchema } from "./workday/schema.js";
import {
  collectPreexistingWorkdayWidgetAnswers,
  normalizeWorkdayProfile,
  planWorkdayUnresolvedWidgets,
  resolveWorkdayDeterministic,
  resolveWorkdayWidgetDeterministic,
  validateResolvedWorkdayWidgetAnswer
} from "./workday/resolver.js";
import {
  computePanelCollectionAddClicks,
  computeWorkExperienceAddClicks,
  fieldOfStudyPromptCandidates,
  normalizeDateWidgetValue,
  optionTextLooselyMatches,
  pickBestRuntimeSourceOption,
  pickFieldOfStudyPromptOption,
  pickPreferredOption,
  pickWorkdayPromptOption,
  planPanelRowAssignments,
  shouldAllowPreexistingWidgetShortCircuit,
  shouldClearDateWidgetBeforeRefill
} from "./workday/executor.js";
import { matchWorkdayInvalidWidgetIdsByErrorLabels, planTargetedWidgetRetry, planWorkdayRetryWidgetIds, shouldSkipWorkdayValidationRepass } from "./workday/recovery.js";

function control(input: Partial<WorkdayControlSnapshot>): WorkdayControlSnapshot {
  return {
    kind: "control",
    rawKey: "raw",
    tag: "input",
    inputType: "text",
    role: "",
    ariaHaspopup: "",
    label: "Label",
    questionLabel: "Label",
    required: true,
    currentValue: null,
    selector: '[id="field"]',
    id: "field",
    inputName: "field",
    dataAutomationId: "field",
    containerKey: "container",
    containerLabel: "Label",
    containerText: "Label",
    promptText: "Label",
    visibleContainerId: "container",
    ...input
  };
}

test("schema extraction groups bare yes no radios into one radio_group", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "yes",
      inputType: "radio",
      label: "Yes",
      optionLabel: "Yes",
      optionSelector: '[id="candidateIsPreviousWorker-yes"]',
      selector: '[id="candidateIsPreviousWorker-yes"]',
      id: "candidateIsPreviousWorker-yes",
      inputName: "candidateIsPreviousWorker",
      dataAutomationId: "candidateIsPreviousWorker",
      questionLabel: "Have you ever worked for this company?"
    }),
    control({
      rawKey: "no",
      inputType: "radio",
      label: "No",
      optionLabel: "No",
      optionSelector: '[id="candidateIsPreviousWorker-no"]',
      selector: '[id="candidateIsPreviousWorker-no"]',
      id: "candidateIsPreviousWorker-no",
      inputName: "candidateIsPreviousWorker",
      dataAutomationId: "candidateIsPreviousWorker",
      questionLabel: "Have you ever worked for this company?"
    })
  ], "contact_information");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "radio_group");
  assert.equal(widgets[0]?.label, "Have you ever worked for this company?");
  assert.deepEqual(widgets[0]?.options, ["Yes", "No"]);
});

test("widget deterministic resolver does not default low-risk application question to no", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "relative-employed",
    step: "application_questions",
    widgetType: "button_select",
    label: "Do you have a relative(s) employed by GPC or any GPC subsidiaries?",
    required: true,
    options: ["Yes", "No"],
    currentValue: "Select One",
    promptText: "Do you have a relative(s) employed by GPC or any GPC subsidiaries?"
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions");
  assert.equal(resolved.get("relative-employed"), undefined);
});

test("schema extraction groups disability options into one checkbox_group", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "disability-yes",
      inputType: "checkbox",
      label: "Yes, I have a disability",
      optionLabel: "Yes, I have a disability",
      optionSelector: '[id="disability-yes"]',
      selector: '[id="disability-yes"]',
      id: "disability-yes",
      inputName: "disability",
      questionLabel: "Please check one of the boxes below"
    }),
    control({
      rawKey: "disability-no",
      inputType: "checkbox",
      label: "No, I do not have a disability",
      optionLabel: "No, I do not have a disability",
      optionSelector: '[id="disability-no"]',
      selector: '[id="disability-no"]',
      id: "disability-no",
      inputName: "disability",
      questionLabel: "Please check one of the boxes below"
    })
  ], "self_identification");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "checkbox_group");
  assert.equal(widgets[0]?.label, "Please check one of the boxes below");
});

test("schema extraction derives parent label for grouped checkbox options from container text", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "notice-2-weeks",
      inputType: "checkbox",
      label: "2 Weeks",
      optionLabel: "2 Weeks",
      optionSelector: '[id="notice-2-weeks"]',
      selector: '[id="notice-2-weeks"]',
      id: "notice-2-weeks",
      inputName: "noticePeriod",
      questionLabel: "",
      containerLabel: "",
      promptText: "",
      containerText: "What is your current notice period, and when would you be available to start work? (Please select all that apply) 2 Weeks 1 Month 2 Months More than 3 Months Available Immediately"
    }),
    control({
      rawKey: "notice-1-month",
      inputType: "checkbox",
      label: "1 Month",
      optionLabel: "1 Month",
      optionSelector: '[id="notice-1-month"]',
      selector: '[id="notice-1-month"]',
      id: "notice-1-month",
      inputName: "noticePeriod",
      questionLabel: "",
      containerLabel: "",
      promptText: "",
      containerText: "What is your current notice period, and when would you be available to start work? (Please select all that apply) 2 Weeks 1 Month 2 Months More than 3 Months Available Immediately"
    })
  ], "application_questions");

  assert.equal(widgets[0]?.widgetType, "checkbox_group");
  assert.equal(
    widgets[0]?.label,
    "What is your current notice period, and when would you be available to start work? (Please select all that apply)"
  );
});

test("schema extraction distinguishes date_mm_yyyy vs date_mm_dd_yyyy", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "start-month",
      label: "Month",
      id: "workExp--startDate-dateSectionMonth-input",
      selector: '[id="workExp--startDate-dateSectionMonth-input"]',
      dateGroupKey: "workExp--startDate",
      sectionCount: 2
    }),
    control({
      rawKey: "start-year",
      label: "Year",
      id: "workExp--startDate-dateSectionYear-input",
      selector: '[id="workExp--startDate-dateSectionYear-input"]',
      dateGroupKey: "workExp--startDate",
      sectionCount: 2
    }),
    control({
      rawKey: "signed-month",
      label: "Month",
      id: "signed--dateSectionMonth-input",
      selector: '[id="signed--dateSectionMonth-input"]',
      dateGroupKey: "signed",
      sectionCount: 3,
      questionLabel: "Date Signed"
    }),
    control({
      rawKey: "signed-day",
      label: "Day",
      id: "signed--dateSectionDay-input",
      selector: '[id="signed--dateSectionDay-input"]',
      dateGroupKey: "signed",
      sectionCount: 3,
      questionLabel: "Date Signed"
    }),
    control({
      rawKey: "signed-year",
      label: "Year",
      id: "signed--dateSectionYear-input",
      selector: '[id="signed--dateSectionYear-input"]',
      dateGroupKey: "signed",
      sectionCount: 3,
      questionLabel: "Date Signed"
    })
  ], "my_experience");

  assert.equal(widgets.find((widget) => widget.label === "Label")?.widgetType, "date_mm_yyyy");
  assert.equal(widgets.find((widget) => widget.label === "Date Signed")?.widgetType, "date_mm_dd_yyyy");
});

test("schema extraction groups split availability date inputs into one parent date widget", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "availability-month",
      label: "MM",
      questionLabel: "MM/DD/YYYY",
      containerLabel: "MM/DD/YYYY",
      containerText: "When would you be available to start? MM DD YYYY",
      promptText: "When would you be available to start? MM DD YYYY",
      id: "primaryQuestionnaire--availability-dateSectionMonth-input",
      selector: '[id="primaryQuestionnaire--availability-dateSectionMonth-input"]',
      dateGroupKey: "primaryQuestionnaire--availability",
      sectionCount: 3
    }),
    control({
      rawKey: "availability-day",
      label: "DD",
      questionLabel: "MM/DD/YYYY",
      containerLabel: "MM/DD/YYYY",
      containerText: "When would you be available to start? MM DD YYYY",
      promptText: "When would you be available to start? MM DD YYYY",
      id: "primaryQuestionnaire--availability-dateSectionDay-input",
      selector: '[id="primaryQuestionnaire--availability-dateSectionDay-input"]',
      dateGroupKey: "primaryQuestionnaire--availability",
      sectionCount: 3
    }),
    control({
      rawKey: "availability-year",
      label: "YYYY",
      questionLabel: "MM/DD/YYYY",
      containerLabel: "MM/DD/YYYY",
      containerText: "When would you be available to start? MM DD YYYY",
      promptText: "When would you be available to start? MM DD YYYY",
      id: "primaryQuestionnaire--availability-dateSectionYear-input",
      selector: '[id="primaryQuestionnaire--availability-dateSectionYear-input"]',
      dateGroupKey: "primaryQuestionnaire--availability",
      sectionCount: 3
    })
  ], "application_questions");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "date_mm_dd_yyyy");
  assert.equal(widgets[0]?.label, "When would you be available to start?");
  assert.equal(widgets[0]?.required, true);
});

test("schema extraction detects source prompts as prompt_input_select", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "source",
      role: "combobox",
      label: "How Did You Hear About Us?",
      questionLabel: "How Did You Hear About Us?",
      dataAutomationId: "sourcePrompt",
      selector: '[id="sourcePrompt"]'
    })
  ], "contact_information");

  assert.equal(widgets[0]?.widgetType, "prompt_input_select");
});

test("schema extraction classifies field of study prompt inputs as prompt_input_select", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "field-of-study",
      tag: "input",
      inputType: "text",
      label: "Field of Study",
      questionLabel: "Field of Study",
      dataAutomationId: "fieldOfStudy",
      id: "education-4--fieldOfStudy",
      inputName: "fieldOfStudy",
      currentValue: "Computer and Information Science",
      containerText: "Field of Study 1 item selected, Computer and Information Science Computer and Information Science"
    })
  ], "my_experience");

  assert.equal(widgets[0]?.widgetType, "prompt_input_select");
  assert.equal(widgets[0]?.currentValue, "Computer and Information Science");
});

test("schema extraction classifies skills prompt inputs as prompt_input_select", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "skills",
      tag: "input",
      inputType: "text",
      label: "Type to Add Skills",
      questionLabel: "Type to Add Skills",
      dataAutomationId: "skillsPrompt",
      id: "skills--skills",
      inputName: "skills",
      currentValue: "0 items selected",
      containerText: "Skills Type to Add Skills 0 items selected"
    })
  ], "my_experience");

  assert.equal(widgets[0]?.widgetType, "prompt_input_select");
});

test("schema extraction collapses uploaded resume helpers into one satisfied file_upload widget", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "resume-select",
      tag: "button",
      inputType: "",
      label: "Upload a file (5MB max)*",
      questionLabel: "Upload a file (5MB max)*",
      containerLabel: "Upload a file (5MB max)*",
      containerText: "Resume/CV Upload a file (5MB max) Drop files here or Select files 4-21Resume.pdf Successfully Uploaded!",
      promptText: "Resume/CV Upload a file (5MB max)",
      selector: '[id="resumeAttachments--attachments"]',
      id: "resumeAttachments--attachments",
      dataAutomationId: "select-files"
    }),
    control({
      rawKey: "resume-delete",
      tag: "button",
      inputType: "",
      label: "Upload a file (5MB max)*",
      questionLabel: "Upload a file (5MB max)*",
      containerLabel: "Upload a file (5MB max)*",
      containerText: "Resume/CV Upload a file (5MB max) 4-21Resume.pdf Successfully Uploaded!",
      promptText: "Resume/CV Upload a file (5MB max)",
      selector: 'button[data-automation-id="delete-file"]',
      dataAutomationId: "delete-file"
    })
  ], "my_experience");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "file_upload");
  assert.equal(widgets[0]?.label, "Resume / CV");
  assert.equal(widgets[0]?.currentValue, "4-21Resume.pdf");
  assert.equal(widgets[0]?.required, true);
});

test("uploaded resume widget is accepted as preexisting", () => {
  const answers = collectPreexistingWorkdayWidgetAnswers([
    widgetFixture({
      widgetId: "resume",
      step: "my_experience",
      label: "Resume / CV",
      widgetType: "file_upload",
      currentValue: "4-21Resume.pdf",
      htmlSummary: { uploadedEvidence: true }
    })
  ], { requiredOnly: true });

  assert.equal(answers.size, 1);
  assert.equal(answers.get("resume")?.source, "preexisting");
  assert.equal(answers.get("resume")?.value, "4-21Resume.pdf");
});

test("schema extraction does not emit upload helper controls as standalone required unknown widgets", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "resume-select",
      tag: "button",
      inputType: "",
      label: "Upload a file (5MB max)*",
      questionLabel: "Upload a file (5MB max)*",
      containerText: "Resume/CV Upload a file (5MB max) Select files",
      selector: '[id="resumeAttachments--attachments"]',
      id: "resumeAttachments--attachments",
      dataAutomationId: "select-files"
    }),
    control({
      rawKey: "resume-delete",
      tag: "button",
      inputType: "",
      label: "Upload a file (5MB max)*",
      questionLabel: "Upload a file (5MB max)*",
      containerText: "Resume/CV Upload a file (5MB max)",
      selector: 'button[data-automation-id="delete-file"]',
      dataAutomationId: "delete-file"
    })
  ], "my_experience");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "file_upload");
});

test("missing uploaded evidence still produces one actionable file_upload widget", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "resume-select",
      tag: "button",
      inputType: "",
      label: "Upload a file (5MB max)*",
      questionLabel: "Upload a file (5MB max)*",
      containerText: "Resume/CV Upload a file (5MB max) Drop files here or Select files",
      promptText: "Resume/CV Upload a file (5MB max)",
      selector: '[id="resumeAttachments--attachments"]',
      id: "resumeAttachments--attachments",
      dataAutomationId: "select-files"
    })
  ], "my_experience");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "file_upload");
  assert.equal(widgets[0]?.currentValue, null);
  const answers = collectPreexistingWorkdayWidgetAnswers(widgets, { requiredOnly: true });
  assert.equal(answers.size, 0);
});

function widgetFixture(input: Partial<WorkdayWidgetSchema>): WorkdayWidgetSchema {
  return {
    widgetId: "widget-1",
    step: "contact_information",
    label: "Label",
    widgetType: "button_select",
    options: [],
    currentValue: null,
    required: true,
    promptText: "",
    visibleContainerId: "container",
    selectorHints: {
      controlSelector: '[id="field"]',
      containerSelector: '[id="container"]'
    },
    htmlSummary: {},
    ...input
  };
}

test("contact source widget uses explicit applicationSource when present", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    applicationSource: "Indeed"
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "source-contact",
      step: "contact_information",
      label: "How Did You Hear About Us?",
      widgetType: "prompt_input_select",
      options: ["LinkedIn", "Indeed", "Employee Referral"],
      selectorHints: {
        controlSelector: '[id="sourcePrompt"]',
        containerSelector: '[id="sourceContainer"]',
        dataAutomationId: "sourcePrompt"
      }
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "contact_information");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "Indeed");
});

test("prefilled field of study resolves as preexisting", () => {
  const answers = collectPreexistingWorkdayWidgetAnswers([
    widgetFixture({
      step: "my_experience",
      label: "Field of Study",
      widgetType: "prompt_input_select",
      currentValue: "Computer and Information Science"
    })
  ], { requiredOnly: false });

  assert.equal(answers.get("widget-1")?.source, "preexisting");
  assert.equal(answers.get("widget-1")?.value, "Computer and Information Science");
});

test("field of study prompt candidates include safe fallbacks", () => {
  assert.deepEqual(fieldOfStudyPromptCandidates("Computer Science"), [
    "computer science",
    "computer and information science",
    "computer and information sciences",
    "computer science, general",
    "software engineering",
    "information technology"
  ]);
});

test("field of study prompt picker uses fallback candidate when exact option missing", () => {
  const picked = pickFieldOfStudyPromptOption("Computer Science", [
    "Mathematics",
    "Computer and Information Sciences",
    "Physics"
  ]);
  assert.equal(picked, "computer and information sciences");
});

test("application source widget falls back to first visible non-placeholder option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "source-application",
      step: "application_questions",
      label: "How did you hear about this job?",
      widgetType: "button_select",
      options: ["Company Website", "LinkedIn", "Indeed", "Employee Referral"],
      selectorHints: {
        controlSelector: '[id="jobSource"]',
        containerSelector: '[id="jobSourceContainer"]',
        dataAutomationId: "jobSource"
      }
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "Company Website");
});

test("application_questions availability date widget resolves to today for date widgets", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    logistics: {
      earliest_start_date: "2026-05-17"
    }
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "availability-date",
      step: "application_questions",
      label: "When would you be available to start?*",
      widgetType: "date_mm_dd_yyyy"
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.deepEqual(resolved.get("availability-date")?.value, ["05", "17", "2026"]);
});

test("application_questions notice period checkbox group resolves to a visible option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "notice-period",
      step: "application_questions",
      label: "What is your current notice period, and when would you be available to start work? (Please select all that apply)",
      widgetType: "checkbox_group",
      options: ["2 Weeks", "1 Month", "2 Months", "More than 3 Months", "Available Immediately"],
      currentValue: null
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.deepEqual(resolved.get("notice-period")?.value, ["Available Immediately"]);
});

test("application_questions location preference checkbox group resolves to job location option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "location-preference",
    step: "application_questions",
    label: "Which US office location would you prefer? Select all that apply.",
    widgetType: "checkbox_group",
    options: ["Seattle, WA", "Chicago, IL", "Austin, TX", "Dallas, TX", "San Jose, CA", "Not Applicable - Not applying to role based in US"],
    currentValue: "",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions", {
    jobContext: {
      url: "https://expedia.wd108.myworkdayjobs.com/private/job/Washington---Seattle-Campus/Data-Science--Analytics-Intern---2026---Seattle_R-98638",
      jobTitle: "Data Science, Analytics Intern - 2026 - Seattle",
      company: "Expedia"
    }
  });

  assert.deepEqual(resolved.get(widget.widgetId)?.value, ["Seattle, WA"]);
});

test("application_questions role preference checkbox group resolves to non-software option generically", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "role-preference",
    step: "application_questions",
    label: "If applying for a Software Development role/Mobile Engineering role with us, what is your stack/role preference? (Preference does not determine final stack placement).",
    widgetType: "checkbox_group",
    options: ["Front-End", "Back-End", "Full Stack", "Machine Learning Engineer", "Data Engineer", "UX Engineer", "Mobile (iOS)", "Mobile (Android)", "Cloud Engineer", "I do not have a preference", "I am not applying for a Software Developer role"],
    currentValue: "",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions", {
    jobContext: {
      url: "https://expedia.wd108.myworkdayjobs.com/private/job/Washington---Seattle-Campus/Data-Science--Analytics-Intern---2026---Seattle_R-98638",
      jobTitle: "Data Science, Analytics Intern - 2026 - Seattle",
      company: "Expedia"
    }
  });

  assert.deepEqual(resolved.get(widget.widgetId)?.value, ["I am not applying for a Software Developer role"]);
});

test("forced required checkbox choice falls back to no-preference style option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "generic-preference",
    step: "application_questions",
    label: "What is your preference? Select all that apply.",
    widgetType: "checkbox_group",
    options: ["Alpha", "Beta", "I do not have a preference"],
    currentValue: "",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions");
  assert.deepEqual(resolved.get(widget.widgetId)?.value, ["I do not have a preference"]);
});

test("application_questions desired start date falls back to today when profile has no explicit logistics date", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "desired-start-date",
    step: "application_questions",
    label: "What is your desired start date?*",
    widgetType: "date_mm_dd_yyyy",
    currentValue: "",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions");
  const now = new Date();
  const expected = [
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getFullYear())
  ];
  assert.deepEqual(resolved.get("desired-start-date")?.value, expected);
});

test("application_questions availability free text resolves from profile logistics date as DD/MM/YYYY", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    logistics: {
      earliestStartDate: "2026-05-17"
    }
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "availability-text",
      step: "application_questions",
      label: "When would you be available to start?*",
      widgetType: "textarea"
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get("availability-text")?.value, "17/05/2026");
});

test("application_questions availability schema text field resolves from profile logistics date as DD/MM/YYYY", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    logistics: {
      earliest_start_date: "2026-05-17"
    }
  } as CandidateProfile);

  const schema = [{
    fieldId: "availability-text",
    label: "When would you be available to start?*",
    required: true,
    fieldType: "text" as const,
    possibleAnswers: [],
    currentValue: "",
    selectorHints: { selector: '[id="availability-text"]' },
    step: "application_questions" as const,
    htmlSummary: {}
  }];

  const resolved = resolveWorkdayDeterministic(schema, profile, "application_questions");
  assert.equal(resolved.get("availability-text")?.value, "17/05/2026");
});

test("source widget fallback accepts first visible non-placeholder option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "source-fallback",
      step: "application_questions",
      label: "Job Source",
      widgetType: "button_select",
      options: ["Employee Referral", "Campus Recruiting", "Company Website"],
      selectorHints: {
        controlSelector: '[id="jobSource"]',
        containerSelector: '[id="jobSourceContainer"]',
        dataAutomationId: "jobSource"
      }
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "Employee Referral");
});

test("schema extraction treats listbox popups as button_select even when rendered as non-button roles", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "application-question-select",
      tag: "div",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Select One",
      questionLabel: "Are you legally authorized to work in the United States?",
      dataAutomationId: "workAuthorization",
      selector: '[data-automation-id="workAuthorization"]'
    })
  ], "application_questions");

  assert.equal(widgets[0]?.widgetType, "button_select");
});

test("schema extraction does not misclassify plain inputs as date widgets", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "email",
      id: "input-4",
      selector: '[id="input-4"]',
      dataAutomationId: "email",
      label: "Email Address",
      questionLabel: "Email Address"
    })
  ], "contact_information");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "text_input");
});

test("contact prior-worker widget deterministically resolves to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "prior-worker-yes",
      inputType: "radio",
      label: "Yes",
      optionLabel: "Yes",
      optionSelector: '[id="prior-worker-yes"]',
      selector: '[id="prior-worker-yes"]',
      id: "prior-worker-yes",
      inputName: "candidateIsPreviousWorker",
      questionLabel: "Previously worked for this company?",
      dataAutomationId: "candidateIsPreviousWorker"
    }),
    control({
      rawKey: "prior-worker-no",
      inputType: "radio",
      label: "No",
      optionLabel: "No",
      optionSelector: '[id="prior-worker-no"]',
      selector: '[id="prior-worker-no"]',
      id: "prior-worker-no",
      inputName: "candidateIsPreviousWorker",
      questionLabel: "Previously worked for this company?",
      dataAutomationId: "candidateIsPreviousWorker"
    })
  ], "contact_information");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "contact_information");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "No");
});

test("contact employer-history widget resolves to Yes when prior employer matches profile list", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    previousEmployers: ["Fiserv"]
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "fiserv-employed-yes",
      inputType: "radio",
      label: "Yes",
      optionLabel: "Yes",
      optionSelector: '[id="fiserv-employed-yes"]',
      selector: '[id="fiserv-employed-yes"]',
      id: "fiserv-employed-yes",
      inputName: "fiservWorkedHere",
      questionLabel: "Are you currently or have you ever worked for Fiserv, First Data or any of their affiliates as an employee or contractor?",
      dataAutomationId: "candidateIsPreviousWorker"
    }),
    control({
      rawKey: "fiserv-employed-no",
      inputType: "radio",
      label: "No",
      optionLabel: "No",
      optionSelector: '[id="fiserv-employed-no"]',
      selector: '[id="fiserv-employed-no"]',
      id: "fiserv-employed-no",
      inputName: "fiservWorkedHere",
      questionLabel: "Are you currently or have you ever worked for Fiserv, First Data or any of their affiliates as an employee or contractor?",
      dataAutomationId: "candidateIsPreviousWorker"
    })
  ], "contact_information");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "contact_information");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "Yes");
});

test("application_questions government employment resolves to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "gov-employment",
      tag: "button",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Select One",
      questionLabel: "Within the past 5 years, have you been employed by the federal or any state or local government or public institution?",
      id: "gov-employment",
      selector: '[id="gov-employment"]',
      dataAutomationId: "primaryQuestionnaire--gov-employment",
      promptText: "Within the past 5 years, have you been employed by the federal or any state or local government or public institution?",
      htmlSummary: { fallbackSelectOne: true }
    })
  ], "application_questions");
  widgets[0]!.options = ["Yes", "No"];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "No");
});

test("application_questions teledyne government conflict question resolves to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "gov-conflict",
    step: "application_questions",
    label: "Are you now or have you ever been an employee of the United States Government and/or do you have any close friends or family who are working directly in a decision making capacity on any Teledyne contract?*",
    widgetType: "button_select",
    options: [],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "No");
  assert.equal(resolved?.reason, "workday_questionnaire_government_conflict_default_no");
});

test("application_questions legal right to work verification resolves to Yes from profile", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "work-right-verification",
    step: "application_questions",
    label: "If hired, can you submit verification of your legal right to work in the United States?*",
    widgetType: "button_select",
    options: [],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "Yes");
  assert.equal(resolved?.reason, "workday_auth_verification_of_work_right");
});

test("application_questions legally permitted to work resolves to Yes from profile", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "legal-permitted",
    step: "application_questions",
    label: "Are you legally permitted to work in the country where this job is located?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "Yes");
});

test("application_questions employment eligibility resolves to sponsorship-aware option", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: true }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "employment-eligibility",
    step: "application_questions",
    label: "Please select the appropriate option describing your employment eligibility.*",
    widgetType: "button_select",
    options: ["Authorized to work without sponsorship", "Require sponsorship"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "Require sponsorship");
});

test("application_questions know anyone at company defaults to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "know-anyone",
    step: "application_questions",
    label: "Are you related to or know anyone that works or has worked at Copart, a subcontractor, or subsidiary?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved, undefined);
});

test("application_questions conflict of interest resolves to No instead of salary fallback", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "conflict-interest",
      tag: "button",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Select One",
      questionLabel: "Conflict of Interest Question 1: HP policy prohibits employees from engaging in activities that pose a conflict of interest, such as receiving compensation from a competitor or significant financial interest held by you or a family member.",
      id: "conflict-interest",
      selector: '[id="conflict-interest"]',
      dataAutomationId: "primaryQuestionnaire--conflict-interest",
      promptText: "Conflict of Interest Question 1",
      htmlSummary: { fallbackSelectOne: true }
    })
  ], "application_questions");
  widgets[0]!.options = ["Yes", "No"];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "No");
});

test("application_questions existing employee resolves to No even when extracted options are polluted", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    experience: {
      currentCompany: "Fiserv"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "existing-employee",
      tag: "button",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Select One",
      questionLabel: "To help us understand your preferences related to personal data and uses for future recruitment processes, are you an existing HP employee?",
      id: "existing-employee",
      selector: '[id="existing-employee"]',
      dataAutomationId: "primaryQuestionnaire--existing-employee",
      promptText: "Are you an existing HP employee?",
      htmlSummary: { fallbackSelectOne: true }
    })
  ], "application_questions");
  widgets[0]!.options = ["My Information", "My Experience", "Application Questions", "Voluntary Disclosures", "Self Identify", "Review"];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "No");
});

test("application_questions located in US resolves to Yes from profile country", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    country: "United States"
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "located-us",
      tag: "button",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Select One",
      questionLabel: "Are you located in US?",
      id: "located-us",
      selector: '[id="located-us"]',
      dataAutomationId: "primaryQuestionnaire--located-us",
      promptText: "Are you located in US?",
      htmlSummary: { fallbackSelectOne: true }
    })
  ], "application_questions");
  widgets[0]!.options = ["Yes", "No"];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "Yes");
});

test("application_questions country of residence resolves to United States live option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    country: "United States"
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "country-residence",
      tag: "button",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Select One",
      questionLabel: "Country of Residence",
      id: "country-residence",
      selector: '[id="country-residence"]',
      dataAutomationId: "primaryQuestionnaire--country-residence",
      promptText: "Country of Residence",
      htmlSummary: { fallbackSelectOne: true }
    })
  ], "application_questions");
  widgets[0]!.options = ["Canada", "United States of America", "Mexico"];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "United States of America");
});

test("application_questions travel percentage follow-up resolves to moderate default", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "travel-percent",
      label: "PLEASE MENTION HOW MUCH % CAN TRAVEL?",
      questionLabel: "PLEASE MENTION HOW MUCH % CAN TRAVEL?",
      id: "travel-percent",
      selector: '[id="travel-percent"]',
      inputType: "text"
    })
  ], "application_questions");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "25%");
});

test("my_experience education widgets deterministically resolve from profile", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      education: [
        {
          school: "San Diego State University",
          degree: "B.S.",
          fieldOfStudy: "Computer Science",
          gpa: "3.86/4.00",
          startYear: "2023",
          endYear: "2027"
        }
      ]
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "edu-school",
      label: "School or University",
      questionLabel: "School or University",
      id: "education-1--school",
      selector: '[id="education-1--school"]',
      inputName: "education-1--school",
      htmlSummary: { sectionKind: "educationSection" }
    }),
    control({
      rawKey: "edu-degree",
      tag: "div",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Degree",
      questionLabel: "Degree",
      id: "education-1--degree",
      selector: '[id="education-1--degree"]',
      inputName: "education-1--degree",
      htmlSummary: { sectionKind: "educationSection" }
    }),
    control({
      rawKey: "edu-language",
      tag: "div",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Language",
      questionLabel: "Language",
      id: "education-1--language",
      selector: '[id="education-1--language"]',
      inputName: "education-1--language",
      htmlSummary: { sectionKind: "educationSection" }
    }),
    control({
      rawKey: "edu-overall",
      label: "Overall",
      questionLabel: "Overall",
      id: "education-1--gradeAverage",
      selector: '[id="education-1--gradeAverage"]',
      inputName: "education-1--gradeAverage",
      htmlSummary: { sectionKind: "educationSection" }
    })
  ], "my_experience");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "my_experience");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "San Diego State University");
  assert.equal(resolved.get(widgets[1]!.widgetId)?.value, "B.S.");
  assert.equal(resolved.get(widgets[2]!.widgetId)?.value, "English");
  assert.equal(resolved.get(widgets[3]!.widgetId)?.value, "3.86/4.00");
});

test("my_experience education date widgets resolve month year arrays", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      education: [
        {
          school: "San Diego State University",
          degree: "B.S.",
          fieldOfStudy: "Computer Science",
          startYear: "2023",
          endYear: "2027"
        }
      ]
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "edu-end-month",
      label: "Month",
      questionLabel: "To (Actual or Expected)",
      id: "education-1--endDate-dateSectionMonth-input",
      selector: '[id="education-1--endDate-dateSectionMonth-input"]',
      dateGroupKey: "education-1--endDate",
      sectionCount: 2,
      htmlSummary: { sectionKind: "educationSection" }
    }),
    control({
      rawKey: "edu-end-year",
      label: "Year",
      questionLabel: "To (Actual or Expected)",
      id: "education-1--endDate-dateSectionYear-input",
      selector: '[id="education-1--endDate-dateSectionYear-input"]',
      dateGroupKey: "education-1--endDate",
      sectionCount: 2,
      htmlSummary: { sectionKind: "educationSection" }
    })
  ], "my_experience");

  const endDateWidget = widgets.find((widget) => widget.widgetType === "date_mm_yyyy");
  assert.ok(endDateWidget);
  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "my_experience");
  assert.deepEqual(resolved.get(endDateWidget!.widgetId)?.value, ["05", "2027"]);
});

test("my_experience education year fields resolve from selector metadata when label is generic", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      education: [
        {
          school: "San Diego State University",
          degree: "B.S.",
          fieldOfStudy: "Computer Science",
          startYear: "2023",
          endYear: "2027"
        }
      ]
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "edu-end-year-only",
      label: "Year",
      questionLabel: "Year",
      id: "education-1--lastYearAttended",
      selector: '[id="education-1--lastYearAttended"]',
      inputName: "education-1--lastYearAttended",
      htmlSummary: { sectionKind: "educationSection" }
    })
  ], "my_experience");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "my_experience");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "2027");
});

test("my_experience language widgets resolve to English and fluent options", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      education: [
        {
          school: "San Diego State University",
          degree: "B.S.",
          fieldOfStudy: "Computer Science",
          startYear: "2023",
          endYear: "2027"
        }
      ]
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "language-name",
      tag: "div",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Language*",
      questionLabel: "Language*",
      id: "language-1--language",
      selector: '[id="language-1--language"]',
      inputName: "language-1--language"
    }),
    control({
      rawKey: "language-overall",
      tag: "div",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Overall*",
      questionLabel: "Overall*",
      id: "language-1--overall",
      selector: '[id="language-1--overall"]',
      inputName: "language-1--overall"
    })
  ], "my_experience");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "my_experience");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "English");
  assert.equal(resolved.get(widgets[1]!.widgetId)?.value, "4 - Fluent");
});

test("my_experience skills widget deterministically resolves first profile skill", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    skillsSummary: "Python, TypeScript"
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "skills-widget",
      step: "my_experience",
      label: "Type to Add Skills*",
      widgetType: "prompt_input_select",
      required: true
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "my_experience");
  assert.equal(resolved.get("skills-widget")?.value, "Python");
});

test("preexisting required my_experience widgets short-circuit before alias or llm", () => {
  const widgets = [
    widgetFixture({
      widgetId: "exp-company",
      step: "my_experience",
      label: "Company*",
      widgetType: "text_input",
      currentValue: "Salesforce",
      required: true
    }),
    widgetFixture({
      widgetId: "exp-location",
      step: "my_experience",
      label: "Location",
      widgetType: "text_input",
      currentValue: "San Francisco, California",
      required: false
    }),
    widgetFixture({
      widgetId: "exp-degree-placeholder",
      step: "my_experience",
      label: "Degree*",
      widgetType: "button_select",
      currentValue: "Select One",
      options: ["Bachelors", "Masters"],
      required: true
    }),
    widgetFixture({
      widgetId: "exp-invalid",
      step: "my_experience",
      label: "Field of Study*",
      widgetType: "text_input",
      currentValue: "Computer Science",
      required: true,
      htmlSummary: { ariaInvalid: true }
    })
  ];

  const resolved = collectPreexistingWorkdayWidgetAnswers(widgets);
  assert.equal(resolved.get("exp-company")?.source, "preexisting");
  assert.equal(resolved.get("exp-company")?.value, "Salesforce");
  assert.equal(resolved.has("exp-location"), false);
  assert.equal(resolved.has("exp-degree-placeholder"), false);
  assert.equal(resolved.has("exp-invalid"), false);
});

test("my_experience preexisting short-circuit can preserve optional filled widgets", () => {
  const widgets = [
    widgetFixture({
      widgetId: "exp-location",
      step: "my_experience",
      label: "Location",
      widgetType: "text_input",
      currentValue: "San Francisco, California",
      required: false
    })
  ];

  const resolved = collectPreexistingWorkdayWidgetAnswers(widgets, { requiredOnly: false });
  assert.equal(resolved.get("exp-location")?.source, "preexisting");
  assert.equal(resolved.get("exp-location")?.value, "San Francisco, California");
});

test("my_experience committed month-year widgets are accepted as preexisting date parts", () => {
  const widgets = [
    widgetFixture({
      widgetId: "exp-from-date",
      step: "my_experience",
      label: "From*",
      widgetType: "date_mm_yyyy",
      currentValue: "5 / 2024",
      required: true,
      htmlSummary: {
        ariaInvalid: true
      }
    })
  ];

  const resolved = collectPreexistingWorkdayWidgetAnswers(widgets, { requiredOnly: false });
  assert.deepEqual(resolved.get("exp-from-date")?.value, ["5", "2024"]);
  assert.equal(resolved.get("exp-from-date")?.source, "preexisting");
});

test("my_experience skills widget with 0 items selected is not accepted as preexisting", () => {
  const widgets = [
    widgetFixture({
      widgetId: "skills-widget",
      step: "my_experience",
      label: "Type to Add Skills*",
      widgetType: "text_input",
      currentValue: "0 items selected",
      required: true
    })
  ];

  const resolved = collectPreexistingWorkdayWidgetAnswers(widgets, { requiredOnly: false });
  assert.equal(resolved.has("skills-widget"), false);
});

test("panel_collection helper widgets are excluded from preexisting answers", () => {
  const widgets = [
    widgetFixture({
      widgetId: "education-panel",
      step: "my_experience",
      label: "Education",
      widgetType: "panel_collection",
      currentValue: "1",
      required: true
    }),
    widgetFixture({
      widgetId: "school",
      step: "my_experience",
      label: "School or University*",
      widgetType: "text_input",
      currentValue: "San Diego State University",
      required: true
    })
  ];

  const resolved = collectPreexistingWorkdayWidgetAnswers(widgets, { requiredOnly: false });
  assert.equal(resolved.has("education-panel"), false);
  assert.equal(resolved.get("school")?.source, "preexisting");
});

test("application_questions career-level checkbox group resolves to Student / Intern", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "career-level",
    step: "application_questions",
    label: "DirectorEntry LevelExecutiveExperienced (Non-Manager)Experienced Team LeaderManagerSenior DirectorSenior Executive (president, CFO, etc.)Senior ManagerStaffStudent / InternTeam LeadVice President",
    widgetType: "checkbox_group",
    options: ["Director", "Entry Level", "Manager", "Student / Intern", "Vice President"],
    currentValue: "",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions");
  assert.deepEqual(resolved.get(widget.widgetId)?.value, ["Student / Intern"]);
});

test("application_questions wotc resolves to decline response instead of yes no or salary", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "wotc",
    step: "application_questions",
    label: "Providing voluntary information to the statement below helps our company participate in the Work Opportunity Tax Credit program. I have reviewed the list above and one or more of the statements applies to me.*",
    widgetType: "button_select",
    options: ["Yes", "No", "Answer I don’t wish to respond"],
    required: true,
    currentValue: "Select One"
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions");
  assert.equal(resolved.get(widget.widgetId)?.value, "Answer I don’t wish to respond");
});

test("application_questions prior employee question defaults to No for low-risk yes no widgets", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "prior-employee",
    step: "application_questions",
    label: "Have you ever worked for Microchip before, either as an employee or contractor?*",
    widgetType: "button_select",
    options: [],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved, undefined);
});

test("application_questions relatives employed question defaults to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "relatives",
    step: "application_questions",
    label: "Do you have relatives employed by Microchip?*",
    widgetType: "button_select",
    options: [],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved, undefined);
});

test("application_questions previous applicant question defaults to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "previous-applicant",
    step: "application_questions",
    label: "Have you previously applied to this company?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved, undefined);
});

test("application_questions conflict of interest question defaults to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "conflict",
    step: "application_questions",
    label: "Do you have any conflict of interest with the company?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "No");
  assert.equal(resolved?.reason, "workday_questionnaire_conflict_of_interest_no");
});

test("application_questions contractor question defaults to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "contractor",
    step: "application_questions",
    label: "Are you a current or former contractor to Synchrony?*",
    widgetType: "button_select",
    options: [],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved, undefined);
});

test("application_questions different name verification question defaults to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "different-name",
    step: "application_questions",
    label: "For the purposes of verifying information on this application, have you ever worked or attended school under a different name at any of the organizations you have listed?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved, undefined);
});

test("application_questions non-compete question defaults to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "non-compete",
    step: "application_questions",
    label: "Are you currently subject to a non-compete agreement?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "No");
  assert.equal(resolved?.reason, "workday_questionnaire_employment_restriction_no");
});

test("required age dropdown selects Yes", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "age-dropdown",
    step: "application_questions",
    label: "Will you be at least 18 years old at or before the start of your internship?*",
    widgetType: "button_select",
    options: ["Select One", "Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "Yes");
});

test("internship commitment dropdown selects Yes", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "commitment-dropdown",
    step: "application_questions",
    label: "Please confirm you're able to commit to the entire duration of the program as stated in the job description?*",
    widgetType: "button_select",
    options: ["Select One", "Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "Yes");
});

test("graduation date dropdown picks profile-backed option", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workday: {
      education: [
        {
          school: "San Diego State University",
          degree: "B.S.",
          fieldOfStudy: "Computer Science",
          endMonth: "05",
          endYear: "2027"
        }
      ]
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "graduation-date-dropdown",
    step: "application_questions",
    label: "When is your expected Graduation Date for your most recent academic degree? (if applicable)*",
    widgetType: "button_select",
    options: ["Select One", "December 2026", "May 2027", "December 2027"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "May 2027");
});

test("professional experience excluding internships chooses low experience option", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "experience-dropdown",
    step: "application_questions",
    label: "How many years of relevant / similar professional work experience do you currently have? (do not include internship experience)*",
    widgetType: "button_select",
    options: ["Select One", "0", "1-2", "3-5", "6+"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "0");
});

test("country of university dropdown chooses United States", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workday: {
      education: [
        {
          school: "San Diego State University",
          degree: "B.S.",
          fieldOfStudy: "Computer Science",
          endYear: "2027"
        }
      ]
    }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "university-country-dropdown",
    step: "application_questions",
    label: "What is the country of residence for the university you anticipate graduating from?*",
    widgetType: "button_select",
    options: ["Select One", "Canada", "United States", "United Kingdom"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "United States");
});

test("application_questions sponsorship does not use low-risk default no", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "sponsorship",
    step: "application_questions",
    label: "Will you now or in the future require sponsorship to work in the United States?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "No");
  assert.equal(resolved?.reason, "workday_auth_sponsorship");
});

test("application_questions citizenship does not use low-risk default no", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" },
    workAuthorization: { authorizedToWork: true, requiresSponsorship: false, usCitizen: true }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "citizenship",
    step: "application_questions",
    label: "Are you a U.S. citizen or national?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions").get(widget.widgetId);
  assert.equal(resolved?.value, "Yes");
  assert.notEqual(resolved?.reason, "workday_questionnaire_default_no_low_risk");
});

test("application_questions criminal questions do not default to No", () => {
  const profile = normalizeWorkdayProfile({
    basics: { firstName: "Test", lastName: "User", fullName: "Test User", email: "test@example.com" }
  } as CandidateProfile);

  const widget = widgetFixture({
    widgetId: "criminal",
    step: "application_questions",
    label: "Have you ever been convicted of a felony?*",
    widgetType: "button_select",
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true
  });

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions");
  assert.equal(resolved.has(widget.widgetId), false);
});

test("option-backed validation rejects numeric answers for yes no widgets", () => {
  const widget = widgetFixture({
    widgetId: "yes-no",
    step: "application_questions",
    label: "Work Opportunity Tax Credit prompt",
    widgetType: "button_select",
    options: ["Yes", "No", "Answer I don’t wish to respond"],
    required: true
  });

  const validation = validateResolvedWorkdayWidgetAnswer(widget, {
    widgetId: widget.widgetId,
    value: "120000",
    source: "rule",
    reason: "bad_binding"
  });

  assert.equal(validation.accepted, false);
  assert.equal(validation.reason, "answer_not_in_options");
});

test("semantic yes no widgets reject non boolean answers when extracted options are empty", () => {
  const widget = widgetFixture({
    widgetId: "semantic-yes-no",
    step: "application_questions",
    label: "If hired, can you submit verification of your legal right to work in the United States?*",
    widgetType: "button_select",
    options: [],
    currentValue: "Select One",
    required: true
  });

  const validation = validateResolvedWorkdayWidgetAnswer(widget, {
    widgetId: widget.widgetId,
    value: "California",
    source: "llm",
    reason: "bad_state"
  });

  assert.equal(validation.accepted, false);
  assert.equal(validation.reason, "answer_not_in_options");
});

test("dependent state intent question resolves profile state from visible options", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    state: "California",
    customAnswers: {
      "do you intend to work in the state where this job was posted?": "No"
    }
  } as CandidateProfile);

  const widgets = [
    widgetFixture({
      widgetId: "posted-state-intent",
      step: "application_questions",
      label: "Do you intend to work in the state where this job was posted?*",
      widgetType: "button_select",
      options: ["Yes", "No"],
      currentValue: "No"
    }),
    widgetFixture({
      widgetId: "work-state",
      step: "application_questions",
      label: "In what state do you intend to work?*",
      widgetType: "button_select",
      options: ["Arizona", "California", "Colorado"],
      currentValue: "Select One"
    })
  ];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get("work-state")?.value, "California");
});

test("state dropdown rejects non-state answers when options are missing", () => {
  const widget = widgetFixture({
    widgetId: "state-no-options",
    step: "application_questions",
    label: "In what state do you intend to work?*",
    widgetType: "button_select",
    options: [],
    currentValue: "Select One"
  });

  const validation = validateResolvedWorkdayWidgetAnswer(widget, {
    widgetId: widget.widgetId,
    value: "Computer Science",
    source: "llm",
    reason: "bad_major"
  });

  assert.equal(validation.accepted, false);
  assert.equal(validation.reason, "answer_not_in_options");
});

test("constrained widget planner repairs llm answers outside visible options with a valid forced option", async () => {
  const profileRaw = {
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    state: "California"
  } as CandidateProfile;

  const planned = await planWorkdayUnresolvedWidgets({
    unresolved: [
      widgetFixture({
        widgetId: "state-llm",
        step: "application_questions",
        label: "In what state do you intend to work?*",
        widgetType: "button_select",
        options: ["Arizona", "California", "Colorado"],
        currentValue: "Select One"
      })
    ],
    contextWidgets: [
      widgetFixture({
        widgetId: "posted-state",
        step: "application_questions",
        label: "Do you intend to work in the state where this job was posted?*",
        widgetType: "button_select",
        options: ["Yes", "No"],
        currentValue: "No"
      })
    ],
    aiEngine: {
      resolve: async () => [{
        questionId: "state-llm",
        value: "Computer Science",
        source: "llm",
        reason: "bad_answer"
      }]
    } as any,
    profile: profileRaw,
    resumeText: "",
    jobContext: {
      url: "https://example.com/jobs/San-Francisco-California/test",
      company: "Example",
      jobTitle: "Intern"
    },
    notes: []
  });

  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.value, "California");
  assert.equal(planned[0]?.source, "rule");
  assert.equal(planned[0]?.reason, "workday_required_option_forced_choice");
});

test("unknown required dropdown chooses first non-placeholder visible option after blank llm reply", async () => {
  const profileRaw = {
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile;

  const planned = await planWorkdayUnresolvedWidgets({
    unresolved: [
      widgetFixture({
        widgetId: "unknown-single-select",
        step: "application_questions",
        label: "Which internship cohort do you prefer?*",
        widgetType: "button_select",
        options: ["Select One", "Cohort A", "Cohort B"],
        currentValue: "Select One",
        required: true
      })
    ],
    aiEngine: {
      resolve: async () => [{
        questionId: "unknown-single-select",
        value: "",
        source: "llm",
        reason: "abstain"
      }]
    } as any,
    profile: profileRaw,
    resumeText: "",
    jobContext: {
      url: "https://example.com/jobs/test",
      company: "Example",
      jobTitle: "Intern"
    },
    notes: []
  });

  assert.equal(planned[0]?.value, "Cohort A");
  assert.equal(planned[0]?.reason, "workday_required_option_forced_choice");
});

test("placeholder-only required dropdown stays unresolved after blank llm reply", async () => {
  const profileRaw = {
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile;

  const planned = await planWorkdayUnresolvedWidgets({
    unresolved: [
      widgetFixture({
        widgetId: "placeholder-only",
        step: "application_questions",
        label: "Unknown required dropdown*",
        widgetType: "button_select",
        options: ["Select One", "Please Select"],
        currentValue: "Select One",
        required: true
      })
    ],
    aiEngine: {
      resolve: async () => [{
        questionId: "placeholder-only",
        value: "",
        source: "llm",
        reason: "abstain"
      }]
    } as any,
    profile: profileRaw,
    resumeText: "",
    jobContext: {
      url: "https://example.com/jobs/test",
      company: "Example",
      jobTitle: "Intern"
    },
    notes: []
  });

  assert.equal(planned.length, 0);
});

test("constrained widget planner includes nearby question context and picks in-options answer", async () => {
  const profileRaw = {
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    state: "California"
  } as CandidateProfile;

  let capturedFieldContext = "";
  const planned = await planWorkdayUnresolvedWidgets({
    unresolved: [
      widgetFixture({
        widgetId: "state-llm-valid",
        step: "application_questions",
        label: "In what state do you intend to work?*",
        widgetType: "button_select",
        options: ["Arizona", "California", "Colorado"],
        currentValue: "Select One"
      })
    ],
    contextWidgets: [
      widgetFixture({
        widgetId: "posted-state-valid",
        step: "application_questions",
        label: "Do you intend to work in the state where this job was posted?*",
        widgetType: "button_select",
        options: ["Yes", "No"],
        currentValue: "No"
      })
    ],
    aiEngine: {
      resolve: async (questions: Array<{ platformMeta?: Record<string, unknown> }>) => {
        capturedFieldContext = String(questions[0]?.platformMeta?.fieldContext || "");
        return [{
          questionId: "state-llm-valid",
          value: "California",
          source: "llm",
          reason: "good_answer"
        }];
      }
    } as any,
    profile: profileRaw,
    resumeText: "",
    jobContext: {
      url: "https://example.com/jobs/San-Francisco-California/test",
      company: "Example",
      jobTitle: "Intern"
    },
    notes: []
  });

  assert.match(capturedFieldContext, /nearby answered questions/i);
  assert.equal(planned[0]?.value, "California");
});

test("required option-backed planner forces llm retry prompt to choose a visible option", async () => {
  const profileRaw = {
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile;

  const capturedFieldContexts: string[] = [];
  const capturedCompanyContexts: string[] = [];
  const planned = await planWorkdayUnresolvedWidgets({
    unresolved: [
      widgetFixture({
        widgetId: "forced-yes-no",
        step: "contact_information",
        label: "Have you ever worked with ExampleCo before?*",
        widgetType: "radio_group",
        options: ["Yes", "No"],
        currentValue: "",
        required: true
      })
    ],
    aiEngine: {
      resolve: async (questions: Array<{ platformMeta?: Record<string, unknown> }>, context?: { companyContext?: string }) => {
        capturedFieldContexts.push(String(questions[0]?.platformMeta?.fieldContext || ""));
        capturedCompanyContexts.push(String(context?.companyContext || ""));
        if (capturedFieldContexts.length === 1) {
          return [{
            questionId: "forced-yes-no",
            value: "",
            source: "llm",
            reason: "abstain"
          }];
        }
        return [{
          questionId: "forced-yes-no",
          value: "No",
          source: "llm",
          reason: "forced_choice"
        }];
      }
    } as any,
    profile: profileRaw,
    resumeText: "",
    jobContext: {
      url: "https://example.com/jobs/test",
      company: "Example",
      jobTitle: "Intern"
    },
    notes: []
  });

  assert.equal(planned[0]?.value, "No");
  assert.match(capturedFieldContexts[1] || "", /must choose one visible option/i);
  assert.match(capturedCompanyContexts[1] || "", /must never be left blank/i);
});

test("required option-backed planner force-fills employer history after empty llm replies", async () => {
  const profileRaw = {
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile;

  const planned = await planWorkdayUnresolvedWidgets({
    unresolved: [
      widgetFixture({
        widgetId: "forced-employer-history",
        step: "contact_information",
        label: "Have you ever worked with ExampleCo as a full-time/part-time employee, intern, vendor, agency temporary, or business guest?*",
        widgetType: "radio_group",
        options: ["Yes", "No"],
        currentValue: "",
        required: true
      })
    ],
    aiEngine: {
      resolve: async () => [{
        questionId: "forced-employer-history",
        value: "",
        source: "llm",
        reason: "abstain"
      }]
    } as any,
    profile: profileRaw,
    resumeText: "",
    jobContext: {
      url: "https://example.com/jobs/test",
      company: "Example",
      jobTitle: "Intern"
    },
    notes: []
  });

  assert.equal(planned[0]?.value, "No");
  assert.equal(planned[0]?.source, "rule");
  assert.equal(planned[0]?.reason, "workday_required_option_forced_choice");
});

test("required option-backed planner force-fills lawfully permitted work question from profile after invalid llm answer", async () => {
  const profileRaw = {
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workAuthorization: {
      authorizedToWork: true,
      requiresSponsorship: false
    }
  } as CandidateProfile;

  const planned = await planWorkdayUnresolvedWidgets({
    unresolved: [
      widgetFixture({
        widgetId: "lawful-auth-forced",
        step: "application_questions",
        label: "Are you lawfully permitted to work in the United States?*",
        widgetType: "button_select",
        options: ["Yes", "No"],
        currentValue: "Select One",
        required: true
      })
    ],
    aiEngine: {
      resolve: async () => [{
        questionId: "lawful-auth-forced",
        value: "California",
        source: "llm",
        reason: "bad_answer"
      }]
    } as any,
    profile: profileRaw,
    resumeText: "",
    jobContext: {
      url: "https://example.com/jobs/test",
      company: "Example",
      jobTitle: "Intern"
    },
    notes: []
  });

  assert.equal(planned[0]?.value, "Yes");
  assert.equal(planned[0]?.source, "rule");
  assert.equal(planned[0]?.reason, "workday_required_option_forced_choice");
});

test("schema extraction ignores standalone dateIcon helper when grouped date widget exists", () => {
  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "availability-month",
      label: "MM",
      questionLabel: "MM/DD/YYYY",
      containerLabel: "MM/DD/YYYY",
      containerText: "When are you available to start? MM DD YYYY",
      promptText: "When are you available to start? MM DD YYYY",
      id: "primaryQuestionnaire--availability-dateSectionMonth-input",
      selector: '[id="primaryQuestionnaire--availability-dateSectionMonth-input"]',
      dataAutomationId: "dateSectionMonth-input",
      dateGroupKey: "primaryQuestionnaire--availability",
      sectionCount: 3
    }),
    control({
      rawKey: "availability-day",
      label: "DD",
      questionLabel: "MM/DD/YYYY",
      containerLabel: "MM/DD/YYYY",
      containerText: "When are you available to start? MM DD YYYY",
      promptText: "When are you available to start? MM DD YYYY",
      id: "primaryQuestionnaire--availability-dateSectionDay-input",
      selector: '[id="primaryQuestionnaire--availability-dateSectionDay-input"]',
      dataAutomationId: "dateSectionDay-input",
      dateGroupKey: "primaryQuestionnaire--availability",
      sectionCount: 3
    }),
    control({
      rawKey: "availability-year",
      label: "YYYY",
      questionLabel: "MM/DD/YYYY",
      containerLabel: "MM/DD/YYYY",
      containerText: "When are you available to start? MM DD YYYY",
      promptText: "When are you available to start? MM DD YYYY",
      id: "primaryQuestionnaire--availability-dateSectionYear-input",
      selector: '[id="primaryQuestionnaire--availability-dateSectionYear-input"]',
      dataAutomationId: "dateSectionYear-input",
      dateGroupKey: "primaryQuestionnaire--availability",
      sectionCount: 3
    }),
    control({
      rawKey: "availability-icon",
      tag: "div",
      label: "Calendar",
      questionLabel: "MM/DD/YYYY",
      containerText: "When are you available to start? MM DD YYYY",
      promptText: "When are you available to start? MM DD YYYY",
      selector: 'div[data-automation-id="dateIcon"]',
      dataAutomationId: "dateIcon"
    })
  ], "application_questions");

  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.widgetType, "date_mm_dd_yyyy");
});

test("my_experience language widgets fall back to raw English when extracted options are incomplete", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      education: [
        {
          school: "San Diego State University",
          degree: "B.S.",
          fieldOfStudy: "Computer Science",
          startYear: "2023",
          endYear: "2027"
        }
      ]
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "language-name-incomplete-options",
      tag: "div",
      role: "button",
      ariaHaspopup: "listbox",
      label: "Language*",
      questionLabel: "Language*",
      id: "language-8--language",
      selector: '[id="language-8--language"]',
      inputName: "language-8--language"
    })
  ], "my_experience");
  widgets[0]!.options = ["German", "Spanish"];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "my_experience");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "English");
});

test("contact source widget resolves to first visible non-placeholder option when no explicit source is present", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "source-linkedin",
      role: "combobox",
      label: "How Did You Hear About Us?",
      questionLabel: "How Did You Hear About Us?",
      dataAutomationId: "sourcePrompt",
      selector: '[id="sourcePrompt"]'
    })
  ], "contact_information").map((widget) => ({
    ...widget,
    options: ["Indeed", "LinkedIn", "Other"]
  }));

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "contact_information");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "Indeed");
});

test("runtime source option picker ignores label-only container text", () => {
  assert.equal(
    pickBestRuntimeSourceOption(["How Did You Hear About Us?", "0 items selected"], "LinkedIn"),
    null
  );
});

test("runtime source option picker falls back to first real visible option", () => {
  assert.equal(
    pickBestRuntimeSourceOption(["How Did You Hear About Us?", "Campus Recruiting Career Site", "Other"], "LinkedIn"),
    "Campus Recruiting Career Site"
  );
});

test("loose option matcher treats ethnicity variants as equivalent", () => {
  assert.equal(
    optionTextLooselyMatches("Hispanic/Latino (United States of America)", "Hispanic or Latino"),
    true
  );
});

test("preferred option picker matches punctuation and parenthetical variants", () => {
  assert.equal(
    pickPreferredOption(["Hispanic/Latino (United States of America)", "Decline to identify"], ["Hispanic or Latino"]),
    "Hispanic/Latino (United States of America)"
  );
});

test("contact prior-worker widget resolves to No for company-specific worked-at labels", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "prior-worker-yes-flex",
      inputType: "radio",
      label: "Yes",
      optionLabel: "Yes",
      optionSelector: '[id="prior-worker-yes-flex"]',
      selector: '[id="prior-worker-yes-flex"]',
      id: "prior-worker-yes-flex",
      inputName: "candidateIsPreviousWorker",
      questionLabel: "Have you previously worked at Flex?",
      dataAutomationId: "candidateIsPreviousWorker"
    }),
    control({
      rawKey: "prior-worker-no-flex",
      inputType: "radio",
      label: "No, I have not",
      optionLabel: "No, I have not",
      optionSelector: '[id="prior-worker-no-flex"]',
      selector: '[id="prior-worker-no-flex"]',
      id: "prior-worker-no-flex",
      inputName: "candidateIsPreviousWorker",
      questionLabel: "Have you previously worked at Flex?",
      dataAutomationId: "candidateIsPreviousWorker"
    })
  ], "contact_information");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "contact_information");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "No, I have not");
});

test("application question deterministic resolver answers background check prompts affirmatively", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "background-yes",
      inputType: "radio",
      label: "Yes",
      optionLabel: "Yes",
      optionSelector: '[id="background-yes"]',
      selector: '[id="background-yes"]',
      id: "background-yes",
      inputName: "backgroundCheck",
      questionLabel: "Are you willing to undergo a background check and drug screen as a condition of employment?"
    }),
    control({
      rawKey: "background-no",
      inputType: "radio",
      label: "No",
      optionLabel: "No",
      optionSelector: '[id="background-no"]',
      selector: '[id="background-no"]',
      id: "background-no",
      inputName: "backgroundCheck",
      questionLabel: "Are you willing to undergo a background check and drug screen as a condition of employment?"
    })
  ], "application_questions");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "Yes");
});

test("application question deterministic resolver falls back to raw yes/no when extracted options are polluted", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workAuthorization: {
      authorizedToWork: true,
      requiresSponsorship: false
    }
  } as CandidateProfile);

  const widgets = [{
    widgetId: "auth-widget",
    step: "application_questions" as const,
    label: "Are you legally authorized to work in the United States?",
    widgetType: "button_select" as const,
    options: [
      "United States Military Veteran",
      "Currently serving in the United States Guard or Reserves",
      "Military Spouse (current or former)"
    ],
    currentValue: "Select One",
    required: true,
    promptText: "",
    visibleContainerId: "container",
    selectorHints: {
      controlSelector: '[id=\"auth-widget\"]'
    },
    htmlSummary: {}
  }];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get("auth-widget")?.value, "Yes");
});

test("application question deterministic resolver maps lawfully permitted work question to yes", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workAuthorization: {
      authorizedToWork: true,
      requiresSponsorship: false
    }
  } as CandidateProfile);

  const widgets = [{
    widgetId: "lawful-auth-widget",
    step: "application_questions" as const,
    label: "Are you lawfully permitted to work in the United States?",
    widgetType: "button_select" as const,
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true,
    promptText: "",
    visibleContainerId: "container",
    selectorHints: {
      controlSelector: '[id=\"lawful-auth-widget\"]'
    },
    htmlSummary: {}
  }];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get("lawful-auth-widget")?.value, "Yes");
});

test("application question deterministic resolver maps on-site willingness to yes", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = [{
    widgetId: "onsite-widget",
    step: "application_questions" as const,
    label: "Are you willing to work on-site?",
    widgetType: "button_select" as const,
    options: ["Yes", "No"],
    currentValue: "Select One",
    required: true,
    promptText: "",
    visibleContainerId: "container",
    selectorHints: {
      controlSelector: '[id=\"onsite-widget\"]'
    },
    htmlSummary: {}
  }];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get("onsite-widget")?.value, "Yes");
});

test("voluntary disclosures ethnicity resolver uses raceEthnicity alias against visible options", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      demographics: {
        raceEthnicity: "Hispanic or Latino"
      }
    }
  } as CandidateProfile);

  const widgets = [{
    widgetId: "ethnicity-widget",
    step: "voluntary_disclosures" as const,
    label: "What is your race/ethnicity?",
    widgetType: "button_select" as const,
    options: ["Asian", "Black or African American", "Hispanic or Latino", "White"],
    currentValue: "Select One",
    required: true,
    promptText: "",
    visibleContainerId: "container",
    selectorHints: {
      controlSelector: '[id=\"ethnicity-widget\"]'
    },
    htmlSummary: {}
  }];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "voluntary_disclosures");
  assert.equal(resolved.get("ethnicity-widget")?.value, "Hispanic or Latino");
});

test("voluntary disclosures ethnicity checkbox group falls back to decline when label is just the first option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = [{
    widgetId: "ethnicity-checkbox-group",
    step: "voluntary_disclosures" as const,
    label: "Asian (Not Hispanic or Latino) (United States of America)",
    widgetType: "checkbox_group" as const,
    options: [
      "Asian (Not Hispanic or Latino) (United States of America)",
      "Black or African American (Not Hispanic or Latino) (United States of America)",
      "Hispanic or Latino (United States of America)",
      "I do not wish to answer. (United States of America)",
      "White (Not Hispanic or Latino) (United States of America)"
    ],
    currentValue: "",
    required: true,
    promptText: "",
    visibleContainerId: "container",
    selectorHints: {
      controlSelector: '[id=\"ethnicity-widget\"]'
    },
    htmlSummary: {}
  }];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "voluntary_disclosures");
  assert.deepEqual(resolved.get("ethnicity-checkbox-group")?.value, ["I do not wish to answer. (United States of America)"]);
  assert.equal(resolved.get("ethnicity-checkbox-group")?.reason, "workday_demo_ethnicity");
});

test("voluntary disclosures gender resolver falls back to decline option when profile value is missing", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    }
  } as CandidateProfile);

  const widgets = [{
    widgetId: "gender-widget",
    step: "voluntary_disclosures" as const,
    label: "Please select the option which best defines your gender.",
    widgetType: "button_select" as const,
    options: ["Male", "Female", "Decline to Self Identify"],
    currentValue: "Select One",
    required: true,
    promptText: "",
    visibleContainerId: "container",
    selectorHints: {
      controlSelector: '[id=\"gender-widget\"]'
    },
    htmlSummary: {}
  }];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "voluntary_disclosures");
  assert.equal(resolved.get("gender-widget")?.value, "Decline to Self Identify");
});

test("application question deterministic resolver maps current degree to closest visible option", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      education: [{
        school: "UC San Diego",
        degree: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        endYear: "2027"
      }]
    }
  } as CandidateProfile);

  const widgets = [{
    widgetId: "degree",
    step: "application_questions" as const,
    label: "What degree are you currently pursuing?",
    widgetType: "button_select" as const,
    options: ["Associate", "Bachelor's Degree", "Master's Degree"],
    currentValue: null,
    required: true,
    promptText: "What degree are you currently pursuing?",
    visibleContainerId: "questions",
    selectorHints: { controlSelector: '[id="degree"]', containerSelector: '[id="degree"]' },
    htmlSummary: { tag: "button" }
  }];

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get("degree")?.value, "Bachelor's Degree");
});

test("application question deterministic resolver uses education GPA profile fact", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    workday: {
      education: [{
        school: "UC San Diego",
        degree: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        gpa: "3.9",
        endYear: "2027"
      }]
    }
  } as CandidateProfile);

  const widgets = buildWorkdayWidgetsFromControls([
    control({
      rawKey: "gpa",
      label: "What is your current cumulative GPA (out of 4.0)?",
      questionLabel: "What is your current cumulative GPA (out of 4.0)?",
      id: "gpa",
      selector: '[id="gpa"]',
      inputType: "number"
    })
  ], "application_questions");

  const resolved = resolveWorkdayWidgetDeterministic(widgets, profile, "application_questions");
  assert.equal(resolved.get(widgets[0]!.widgetId)?.value, "3.9");
});

test("prompt-input source handler accepts first valid visible option when preferred mapping is unavailable", () => {
  const picked = pickWorkdayPromptOption("LinkedIn", ["Select One", "Job Board", "Employee Referral"]);
  assert.equal(picked, "Job Board");
});

test("pickPreferredOption chooses the highest-priority visible source option", () => {
  const picked = pickPreferredOption(
    ["Employee Referral", "Company Website", "Other"],
    ["LinkedIn", "Company Website", "Careers Website", "Indeed", "Other"]
  );
  assert.equal(picked, "Company Website");
});

test("pickPreferredOption chooses the best visible negative prior-company option", () => {
  const picked = pickPreferredOption(
    ["Yes", "Never"],
    ["No", "No, I have not", "Never"]
  );
  assert.equal(picked, "Never");
});

test("pickPreferredOption ignores placeholder values when choosing first usable option", () => {
  const picked = pickPreferredOption(
    ["Select One", "Employee Referral", "Other"],
    ["Employee Referral", "Other"]
  );
  assert.equal(picked, "Employee Referral");
});

test("date widget normalization handles month-year and month-day-year answers", () => {
  assert.deepEqual(normalizeDateWidgetValue("date_mm_yyyy", "03/2012"), ["03", "2012"]);
  assert.deepEqual(normalizeDateWidgetValue("date_mm_dd_yyyy", "05/01/2026"), ["05", "01", "2026"]);
  assert.deepEqual(normalizeDateWidgetValue("date_mm_dd_yyyy", "2026-05-17"), ["05", "17", "2026"]);
});

test("availability label recovery targets grouped parent date widget", () => {
  const retryIds = matchWorkdayInvalidWidgetIdsByErrorLabels(
    [
      { widgetId: "availability_parent", label: "When would you be available to start?" },
      { widgetId: "other_field", label: "Other question" }
    ],
    ["When would you be available to start?"]
  );

  assert.deepEqual(retryIds, ["availability_parent"]);
});

test("application_questions graduation date date widget resolves profile mm dd yyyy format", () => {
  const profile = normalizeWorkdayProfile({
    basics: {
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      email: "test@example.com"
    },
    education: {
      school: "Example University",
      degree: "B.S.",
      field: "Computer Science",
      endMonth: "May",
      endYear: "2027",
      graduationDateMmDdYyyy: "05/15/2027",
      graduationDateMmYyyy: "05/2027"
    }
  } as CandidateProfile);

  const widget: WorkdayWidgetSchema = {
    widgetId: "graduation_date",
    step: "application_questions",
    label: "What is your expected graduation date?",
    widgetType: "date_mm_dd_yyyy",
    options: [],
    currentValue: null,
    required: true,
    promptText: "MM/DD/YYYY",
    visibleContainerId: "questionnaire",
    selectorHints: {},
    htmlSummary: {}
  };

  const resolved = resolveWorkdayWidgetDeterministic([widget], profile, "application_questions");
  assert.deepEqual(resolved.get(widget.widgetId)?.value, ["05", "15", "2027"]);
});

test("date widget corrupted stale year state is cleared before refill", () => {
  assert.equal(
    shouldClearDateWidgetBeforeRefill("date_mm_dd_yyyy", ["05", "", "2005"], ["05", "17", "2026"]),
    true
  );
  assert.equal(
    shouldClearDateWidgetBeforeRefill("date_mm_dd_yyyy", ["05", "17", "2026"], ["05", "17", "2026"]),
    false
  );
});

test("experience panel reconciliation does not add duplicate rows when one already exists", () => {
  const plan = planPanelRowAssignments(
    [{ primary: "Software Engineer", secondary: "Acme" }],
    [{ primary: "Software Engineer", secondary: "Acme" }]
  );

  assert.equal(plan.addCount, 0);
  assert.deepEqual(plan.assignments, [{ visibleIndex: 0, desiredIndex: 0 }]);
});

test("targeted recovery only retries invalid widgets", () => {
  const retryIds = planTargetedWidgetRetry(
    [{ widgetId: "experience_panel" }, { widgetId: "source_prompt" }, { widgetId: "phone" }],
    ["source_prompt"]
  );

  assert.deepEqual(retryIds, ["source_prompt"]);
});

test("error-label retry matching requires exact normalized label match", () => {
  const retryIds = matchWorkdayInvalidWidgetIdsByErrorLabels(
    [
      { widgetId: "sponsorship_now", label: "Will you require sponsorship now?" },
      { widgetId: "sponsorship_future", label: "Will you require sponsorship now or in the future?" }
    ],
    ["Error - Will you require sponsorship now?*"]
  );

  assert.deepEqual(retryIds, ["sponsorship_now"]);
});

test("application question retry planning keeps only DOM-invalid verified widgets", () => {
  const retryIds = planWorkdayRetryWidgetIds({
    widgets: [
      { widgetId: "auth_locked" },
      { widgetId: "sponsorship_locked" },
      { widgetId: "other_unlocked" }
    ],
    domInvalidWidgetIds: ["auth_locked"],
    errorLabelMatchedWidgetIds: ["sponsorship_locked", "other_unlocked"],
    currentStep: "application_questions",
    lockedWidgetIds: ["auth_locked", "sponsorship_locked"]
  });

  assert.deepEqual(retryIds, ["auth_locked"]);
});

test("application question retry planning drops label-only matches for locked verified widgets", () => {
  const retryIds = planWorkdayRetryWidgetIds({
    widgets: [
      { widgetId: "auth_locked" },
      { widgetId: "other_unlocked" }
    ],
    domInvalidWidgetIds: [],
    errorLabelMatchedWidgetIds: ["auth_locked", "other_unlocked"],
    currentStep: "application_questions",
    lockedWidgetIds: ["auth_locked"]
  });

  assert.deepEqual(retryIds, ["other_unlocked"]);
});

test("application question validation repass is disabled", () => {
  assert.equal(shouldSkipWorkdayValidationRepass("application_questions"), true);
  assert.equal(shouldSkipWorkdayValidationRepass("contact_information"), false);
});

test("work experience add clicks use profile count with prerendered row baseline", () => {
  assert.equal(computeWorkExperienceAddClicks(0, false), 0);
  assert.equal(computeWorkExperienceAddClicks(1, false), 1);
  assert.equal(computeWorkExperienceAddClicks(3, false), 3);
  assert.equal(computeWorkExperienceAddClicks(1, true), 0);
  assert.equal(computeWorkExperienceAddClicks(3, true), 2);
});

test("panel collection add clicks back off by estimated existing rows", () => {
  assert.equal(computePanelCollectionAddClicks(0, 3), 0);
  assert.equal(computePanelCollectionAddClicks(2, 0), 2);
  assert.equal(computePanelCollectionAddClicks(2, 1), 1);
  assert.equal(computePanelCollectionAddClicks(2, 2), 0);
  assert.equal(computePanelCollectionAddClicks(2, 4), 0);
});

test("application question selects do not allow stale preexisting short circuit", () => {
  assert.equal(shouldAllowPreexistingWidgetShortCircuit("application_questions", "button_select"), false);
  assert.equal(shouldAllowPreexistingWidgetShortCircuit("application_questions", "prompt_input_select"), false);
  assert.equal(shouldAllowPreexistingWidgetShortCircuit("application_questions", "radio_group"), true);
  assert.equal(shouldAllowPreexistingWidgetShortCircuit("contact_information", "button_select"), true);
});
