# Universal Profile Intake Spec (All Adapters)

This document defines the user fields we should ingest to run `greenhouse`, `lever`, `ashby`, `workday`, `workatastartup`, and `generic` from one profile.


### Tier 0 (hard minimum)
- `basics.firstName`
- `basics.lastName`
- `basics.email`
- `basics.phone`
- `basics.location` (city/state/country string)
- `workAuthorization.authorizedToWork`
- `workAuthorization.requiresSponsorship`
- `country`
- `resumePath` in config or file override


### Tier 1 (strongly recommended for cross-adapter stability)
- `basics.fullName`
- `state`
- `links.linkedin`
- `links.github`
- `links.portfolio` or `links.website`
- `education.school`
- `education.degree` or `education.highestDegree`
- `education.field`
- `education.startYear`
- `education.endYear` or `education.graduationYear`
- `education.gpa` (if student/intern roles)
- `experience.years`
- `experience.summary`
- `experience.currentCompany`
- `experience.currentTitle`
- `skillsSummary`
- `salary`
- `applicationSource`
- `locationStructured.city`
- `locationStructured.region`
- `locationStructured.country`

### Tier 2 (adapter-specific reliability fields)

#### Workday block
- `workday.account.email`
- `workday.account.password`
- `workday.identity.fullName`
- `workday.identity.firstName`
- `workday.identity.lastName`
- `workday.contact.email`
- `workday.contact.phone`
- `workday.contact.phoneType`
- `workday.contact.address.line1`
- `workday.contact.address.city`
- `workday.contact.address.state`
- `workday.contact.address.postalCode`
- `workday.contact.address.country`
- `workday.workAuthorization.authorizedInUS`
- `workday.workAuthorization.requiresSponsorship`
- `workday.experience[]` (title/company/location/start/end/description)
- `workday.education[]` (school/degree/field/start/end/gpa)
- `workday.links.linkedin` (plus github/portfolio if available)
- `workday.demographics.*` if user opts in

#### Ashby/Greenhouse/Lever optional boosters
- `previousEmployers[]`
- `exportControl.usPerson`
- `logistics.earliestStartDate`
- `logistics.allowDateFallbackToday`

## Custom Answers Contract

Store free-form and tenant-specific prompts in `customAnswers` with normalized keys.

Examples that have shown up in live runs:
- `"father's family name"`
- `"mother's family name"`
- `"current country of residence"`
- `"country of residence"`
- `"willing to relocate"`
- `"open to relocation"`
- `"overall gpa"`
- `"transcript available"`
- `"transcript path"`
- `"requires sponsorship"`
- `"veteran status"`
- `"disability status"`

Rules:
- Keep keys lowercase where possible.
- Store boolean prompts as `true/false` when semantic yes/no is intended.
- Store constrained choices as exact option text when known.
- Keep path-like values absolute for local-run compatibility.

## Canonical JSON Shape

```json
{
  "basics": {
    "firstName": "First",
    "lastName": "Last",
    "fullName": "First Last",
    "email": "user@example.com",
    "phone": "+1-555-555-5555",
    "location": "San Diego, California, United States"
  },
  "locationStructured": {
    "city": "San Diego",
    "region": "California",
    "country": "United States"
  },
  "links": {
    "linkedin": "https://www.linkedin.com/in/example/",
    "github": "https://github.com/example",
    "portfolio": "https://example.dev",
    "website": "https://example.dev"
  },
  "workAuthorization": {
    "authorizedToWork": true,
    "requiresSponsorship": false,
    "usCitizen": true,
    "permanentResident": false,
    "visaStatus": "",
    "clearanceLevel": "none"
  },
  "exportControl": {
    "usPerson": true
  },
  "education": {
    "highestDegree": "B.S. Computer Science",
    "school": "Example University",
    "degree": "B.S.",
    "field": "Computer Science",
    "startMonth": "August",
    "startYear": "2023",
    "endMonth": "May",
    "endYear": "2027",
    "graduationYear": "2027",
    "graduationDateMmDdYyyy": "05/01/2027",
    "graduationDateMmYyyy": "05/2027",
    "gpa": "3.8/4.0"
  },
  "experience": {
    "years": 2,
    "summary": "Summary of relevant experience",
    "currentCompany": "Company",
    "currentTitle": "Title"
  },
  "applicationSource": "Online Job Board",
  "salary": "$120,000-$150,000",
  "country": "United States",
  "state": "California",
  "skillsSummary": "TypeScript, Python, Playwright, React",
  "previousEmployers": ["Company A", "Company B"],
  "logistics": {
    "earliestStartDate": "2026-06-01",
    "allowDateFallbackToday": true
  },
  "customAnswers": {
    "willing to relocate": true,
    "father's family name": "Example",
    "mother's family name": "Example"
  },
  "workday": {
    "account": {
      "email": "user@example.com",
      "password": "ChangeMe123!"
    },
    "identity": {
      "fullName": "First Last",
      "firstName": "First",
      "lastName": "Last"
    },
    "contact": {
      "email": "user@example.com",
      "phone": "+1-555-555-5555",
      "phoneType": "Mobile",
      "address": {
        "line1": "123 Main St",
        "city": "San Diego",
        "state": "California",
        "postalCode": "91913",
        "country": "United States"
      }
    },
    "workAuthorization": {
      "authorizedInUS": true,
      "requiresSponsorship": false
    },
    "experience": [],
    "education": [],
    "skills": [],
    "links": {
      "linkedin": "https://www.linkedin.com/in/example/"
    }
  }
}
```

## Intake Validation Rules

- Reject if Tier 0 is missing.
- Warn (do not reject) when Tier 1 fields are missing.
- For student/intern applications, require `education.gpa` and graduation timeline fields.
- If `workday` adapter is enabled, require the Workday block.
- Normalize location to `City, State/Province, Country` before storage.
- Keep `customAnswers` as the primary escape hatch for tenant-specific required prompts.

## Expected Formatting Question (Required Intake Step)

Every onboarding should include one explicit question block:

"How should we format your answers for application systems that use different value sets (for example degree names, work authorization wording, and demographic labels)?"

Collect and save this in a `formatPreferences` object so adapters can render platform-specific values from one canonical profile.

### Suggested intake payload
- `formatPreferences.degreeFormat`: `"short"` or `"long"`
- `formatPreferences.locationFormat`: `"city_state_country"` (default)
- `formatPreferences.sponsorshipFormat`: `"boolean"` or `"explicit_text"`
- `formatPreferences.demographicResponseStyle`: `"decline_by_default"` or `"profile_exact"`
- `formatPreferences.dateFormat`: `"MM/DD/YYYY"` and `"MM/YYYY"` support flags

If the user skips this, default to:
- `degreeFormat = "long"`
- `locationFormat = "city_state_country"`
- `sponsorshipFormat = "boolean"`
- `demographicResponseStyle = "decline_by_default"`

## Cross-Adapter Formatting Parity Rules

Store one canonical value, then render adapter-specific strings at runtime.

### Degree normalization
- Canonical store:
  - `education.degree = "B.S."`
  - `education.highestDegree = "Bachelor's Degree"`
- Ashby/Greenhouse expected:
  - `"Bachelor's Degree"` style option text.
- Workday expected:
  - Site option text match from widget choices; fallback from canonical `degree` or `highestDegree`.

### Location normalization
- Canonical store:
  - `locationStructured.city`
  - `locationStructured.region`
  - `locationStructured.country`
  - `basics.location = "City, State/Province, Country"`
- Adapter render:
  - Ashby/Greenhouse/Lever: typeahead with `City, State/Province, Country`.
  - Workday: split address fields (`line1`, `city`, `state`, `postalCode`, `country`) plus display location string where needed.

### Work authorization normalization
- Canonical store:
  - `workAuthorization.authorizedToWork` (boolean)
  - `workAuthorization.requiresSponsorship` (boolean)
- Adapter render:
  - Yes/No controls map from booleans.
  - Country-based authorization questions prefer `country` option when offered.
  - Explicit visa/sponsorship prompts map from boolean + optional `visaStatus`.

### Demographic normalization
- Canonical store:
  - Profile exact values when user provides them.
  - Else safe defaults in mapper (`decline`/`prefer not to say` patterns).
- Adapter render:
  - Always choose exact option text present on target form.

### Date normalization
- Canonical store:
  - ISO-like or structured date in profile/logistics.
- Adapter render:
  - Convert to prompt-required format (`MM/DD/YYYY`, `MM/YYYY`, month name + year).

## Save Shape For Formatting

Add this block to saved profiles:

```json
{
  "formatPreferences": {
    "degreeFormat": "long",
    "locationFormat": "city_state_country",
    "sponsorshipFormat": "boolean",
    "demographicResponseStyle": "decline_by_default",
    "dateFormats": {
      "mmDdYyyy": true,
      "mmYyyy": true
    }
  }
}
```

## Intake UX Guidance

For many fields, use LLM + deterministic mappers from a simpler onboarding flow:
- Do not ask for every ATS variant directly.
- Example: if a form asks for family surname, map from `basics.lastName` unless user provided an override in `customAnswers`.
- Always persist canonical data plus `formatPreferences`, then adapter-specific rendering happens at execution time.

Every saved field must resolve to the expected target control shape during runtime.
