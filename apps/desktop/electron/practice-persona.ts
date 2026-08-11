import type { UserProfileInput } from "@automa/shared-types";

/**
 * A deliberately fictional candidate, so the whole app can be explored without
 * typing anything and without inventing a real person.
 *
 * Every value is safe by construction:
 *  - example.com is reserved for documentation (RFC 2606)
 *  - 555-01xx is the reserved fictional US phone range
 *  - the address, school and employers are obviously placeholders
 *
 * Every protected question answers "decline to self identify". That is not
 * laziness: it demonstrates the safety policy. Automa must never invent a
 * legal or demographic answer, least of all for a persona that is not real.
 */
export const GUEST_PERSONA: UserProfileInput = {
  basics: {
    firstName: "Alex",
    lastName: "Rivera",
    fullName: "Alex Rivera",
    email: "alex.rivera@example.com",
    phone: "+1 (555) 0142",
    location: "Austin, TX"
  },
  locationStructured: {
    city: "Austin",
    region: "Texas",
    country: "United States"
  },
  links: {
    linkedin: "https://www.example.com/in/alex-rivera-demo",
    github: "https://www.example.com/alex-rivera-demo",
    portfolio: "https://alexrivera.example.com"
  },
  workAuthorization: {
    authorizedToWork: true,
    requiresSponsorship: false,
    usCitizen: true,
    permanentResident: false
  },
  education: {
    highestDegree: "Bachelor's",
    school: "Example State University",
    university: "Example State University",
    degree: "B.S.",
    field: "Computer Science",
    discipline: "Computer Science",
    startMonth: "08",
    startYear: "2018",
    endMonth: "05",
    endYear: "2022",
    graduationYear: "2022",
    gpa: "3.6"
  },
  experience: {
    years: 3,
    currentTitle: "Software Engineer",
    currentCompany: "Example Labs",
    summary:
      "Software engineer with three years building web applications and internal tooling. " +
      "Works across TypeScript, React and Node, with a focus on reliability and clear interfaces. " +
      "This is a demonstration profile and does not describe a real person."
  },
  previousEmployers: ["Example Labs", "Demo Systems Inc."],
  // Workday makes you create an account on the employer's own tenant before it
  // will show the application. The demo persona carries throwaway credentials
  // so the bundled Workday practice application can run end to end; they are
  // fictional and are never sent anywhere real.
  workday: {
    account: {
      email: "alex.rivera@example.com",
      password: "DemoOnly-NotARealAccount-2026"
    }
  },
  logistics: {
    earliestStartDate: "2026-09-01"
  },
  preferences: {
    desiredRoles: ["Software Engineer", "Full Stack Engineer", "Backend Engineer"],
    desiredLocations: ["Remote", "Austin, TX"],
    employmentTypes: ["full-time"],
    remoteOnly: false
  },
  customAnswers: {
    "years of experience": "3",
    "willing to relocate": "Yes",
    "notice period": "2 weeks",
    "desired salary": "120000",
    "how did you hear about us": "Company website",
    "why do you want to work here":
      "This is a demonstration profile used to exercise Automa's form filling. It is not a real application."
  }
};

/** The demographic answers, kept separate because they are always declines. */
export const GUEST_DEMOGRAPHICS = {
  gender: "Decline to self identify",
  hispanicOrLatino: "Decline to self identify",
  raceEthnicity: "Decline to self identify",
  veteranStatus: "I don't wish to answer",
  disabilityStatus: "decline" as const
};

export const GUEST_RESUME_FILE_NAME = "alex-rivera-demo-resume.pdf";

/**
 * The resume rendered to PDF by Electron's own printToPDF, so generating it
 * costs no dependency. The footer states plainly that it is not real, so the
 * file can never be mistaken for a genuine application document.
 */
export function guestResumeHtml(): string {
  const p = GUEST_PERSONA;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${p.basics.fullName} — Résumé</title>
<style>
  @page { margin: 0; }
  body {
    font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #171a24; margin: 0; padding: 48px 56px; font-size: 11.5px; line-height: 1.5;
  }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.4px; }
  .contact { color: rgba(23,26,36,0.62); font-size: 11px; margin-bottom: 22px; }
  h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: rgba(23,26,36,0.62); margin: 22px 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid rgba(11,16,32,0.12);
  }
  .row { display: flex; justify-content: space-between; margin-bottom: 2px; }
  .role { font-weight: 600; }
  .meta { color: rgba(23,26,36,0.62); font-size: 10.5px; }
  ul { margin: 4px 0 12px; padding-left: 16px; }
  li { margin-bottom: 3px; }
  .footer {
    margin-top: 34px; padding-top: 10px; border-top: 1px solid rgba(11,16,32,0.12);
    color: rgba(23,26,36,0.55); font-size: 9.5px;
  }
</style></head>
<body>
  <h1>${p.basics.fullName}</h1>
  <div class="contact">
    ${p.basics.email} &nbsp;·&nbsp; ${p.basics.phone} &nbsp;·&nbsp; ${p.basics.location}<br/>
    ${p.links?.linkedin ?? ""} &nbsp;·&nbsp; ${p.links?.github ?? ""}
  </div>

  <h2>Summary</h2>
  <div>${p.experience?.summary ?? ""}</div>

  <h2>Experience</h2>
  <div class="row"><span class="role">Software Engineer — Example Labs</span><span class="meta">2023 – Present</span></div>
  <ul>
    <li>Built and maintained internal web tooling used across several teams.</li>
    <li>Improved page load time on the main dashboard by reducing redundant data fetching.</li>
    <li>Added an automated test suite covering the highest traffic user flows.</li>
  </ul>
  <div class="row"><span class="role">Junior Software Engineer — Demo Systems Inc.</span><span class="meta">2022 – 2023</span></div>
  <ul>
    <li>Implemented REST endpoints and the React screens that consumed them.</li>
    <li>Wrote the onboarding documentation used by new engineers.</li>
  </ul>

  <h2>Education</h2>
  <div class="row">
    <span class="role">${p.education?.degree} ${p.education?.field} — ${p.education?.school}</span>
    <span class="meta">${p.education?.endYear}</span>
  </div>
  <div class="meta">GPA ${p.education?.gpa}</div>

  <h2>Skills</h2>
  <div>TypeScript, JavaScript, React, Node.js, PostgreSQL, SQLite, Playwright, Git, CI/CD</div>

  <div class="footer">
    Generated demonstration résumé. Alex Rivera is not a real person and this
    document does not describe a real work history. It exists so Automa can be
    tried without entering personal information.
  </div>
</body></html>`;
}

/**
 * The résumé as plain text. Taken from the same source strings as the PDF, so
 * answering never depends on how well a parser read our own generated file.
 */
export function guestResumeText(): string {
  const p = GUEST_PERSONA;
  return [
    p.basics.fullName,
    `${p.basics.email} | ${p.basics.phone} | ${p.basics.location}`,
    "",
    "SUMMARY",
    p.experience?.summary ?? "",
    "",
    "EXPERIENCE",
    "Software Engineer, Example Labs (2023 - Present)",
    "- Built and maintained internal web tooling used across several teams.",
    "- Improved dashboard load time by reducing redundant data fetching.",
    "- Added an automated test suite covering the highest traffic user flows.",
    "Junior Software Engineer, Demo Systems Inc. (2022 - 2023)",
    "- Implemented REST endpoints and the React screens that consumed them.",
    "- Wrote the onboarding documentation used by new engineers.",
    "",
    "EDUCATION",
    `${p.education?.degree} ${p.education?.field}, ${p.education?.school}, ${p.education?.endYear} (GPA ${p.education?.gpa})`,
    "",
    "SKILLS",
    "TypeScript, JavaScript, React, Node.js, PostgreSQL, SQLite, Playwright, Git, CI/CD",
    "",
    "This is a demonstration resume. Alex Rivera is not a real person."
  ].join("\n");
}
