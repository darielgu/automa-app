import type { Locator, Page } from "playwright-core";

export type WorkdayStep =
  | "sign_in"
  | "create_account"
  | "start"
  | "contact_information"
  | "my_experience"
  | "application_questions"
  | "voluntary_disclosures"
  | "self_identification"
  | "take_assessment"
  | "review"
  | "submit"
  | "unknown";

export type WorkdayFieldType =
  | "text"
  | "textarea"
  | "dropdown"
  | "search_combobox"
  | "radio"
  | "checkbox"
  | "date_month_year"
  | "file"
  | "panel_collection"
  | "unknown";

export type WorkdayWidgetType =
  | "text_input"
  | "textarea"
  | "button_select"
  | "prompt_input_select"
  | "radio_group"
  | "checkbox_group"
  | "date_mm_yyyy"
  | "date_mm_dd_yyyy"
  | "file_upload"
  | "panel_collection"
  | "unknown";

export interface WorkdayFieldSchema {
  fieldId: string;
  label: string;
  required: boolean;
  fieldType: WorkdayFieldType;
  possibleAnswers: string[];
  currentValue: string | string[] | null;
  selectorHints: {
    id?: string;
    dataAutomationId?: string;
    role?: string;
    inputName?: string;
    selector?: string;
  };
  step: WorkdayStep;
  htmlSummary: Record<string, unknown>;
}

export interface WorkdayWidgetSchema {
  widgetId: string;
  step: WorkdayStep;
  label: string;
  widgetType: WorkdayWidgetType;
  options: string[];
  currentValue: string | string[] | null;
  required: boolean;
  promptText: string;
  visibleContainerId: string;
  selectorHints: {
    controlSelector?: string;
    containerSelector?: string;
    optionSelectors?: Record<string, string>;
    id?: string;
    dataAutomationId?: string;
    role?: string;
    inputName?: string;
    monthSelector?: string;
    daySelector?: string;
    yearSelector?: string;
    fileInputSelector?: string;
    addButtonSelector?: string;
    rowPrefixFieldSuffix?: string;
    panelItemPrefixes?: string[];
  };
  htmlSummary: Record<string, unknown>;
}

export interface WorkdayApplicationQuestionsExtractionDiagnostics {
  activeContainerSelectorUsed: string;
  activeContainerTextSnippet: string;
  ariaHaspopupButtonCount: number;
  selectOneButtonCount: number;
  visibleListboxButtonCount: number;
  requiredAriaLabelCount: number;
  formFieldNodeCount: number;
  visibleRequiredSelectOneCount: number;
  topVisibleButtons: Array<{
    text: string;
    ariaLabel: string;
    dataAutomationId: string;
  }>;
}

function dedupeNormalizedOptions(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((item) => normalizeText(item)).filter(Boolean)) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

const WORKDAY_FLOW_STEP_OPTION_PATTERNS: RegExp[] = [
  /^my information$/i,
  /^my experience$/i,
  /^application questions$/i,
  /^voluntary disclosures$/i,
  /^self identify(?:ication)?$/i,
  /^take assessment$/i,
  /^review(?: and submit)?$/i,
  /^submit$/i,
];

function isWorkdayFlowStepOption(value: string): boolean {
  const normalized = normalizeText(value);
  return WORKDAY_FLOW_STEP_OPTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function sanitizeHydratedWidgetOptions(widget: WorkdayWidgetSchema, values: string[]): string[] {
  const options = dedupeNormalizedOptions(values);
  if (widget.step !== "application_questions") return options;
  const filtered = options.filter((option) => !isWorkdayFlowStepOption(option));
  return filtered.length ? filtered : [];
}

export interface WorkdayControlSnapshot {
  kind: "control" | "panel";
  rawKey: string;
  tag: string;
  inputType: string;
  role: string;
  ariaHaspopup: string;
  label: string;
  questionLabel: string;
  required: boolean;
  currentValue: string | string[] | null;
  selector: string;
  id: string;
  inputName: string;
  dataAutomationId: string;
  containerKey: string;
  containerLabel: string;
  containerText: string;
  optionLabel?: string;
  optionSelector?: string;
  promptText: string;
  visibleContainerId: string;
  dateGroupKey?: string;
  sectionCount?: number;
  addButtonSelector?: string;
  rowPrefixFieldSuffix?: string;
  panelItemPrefixes?: string[];
  htmlSummary?: Record<string, unknown>;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isGenericDateLabel(value: string): boolean {
  const normalized = normalizeText(value).toLowerCase();
  return /^(mm|dd|yyyy|month|day|year|mm\/yyyy|mm\/dd\/yyyy)$/.test(normalized);
}

function cleanDateGroupLabelCandidate(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return normalizeText(
    normalized
      .replace(/\b(?:mm\/dd\/yyyy|mm\/yyyy)\b/gi, " ")
      .replace(/\b(?:mm|dd|yyyy|month|day|year)\b/gi, " ")
      .replace(/\s+/g, " ")
  );
}

function deriveDateGroupLabel(group: WorkdayControlSnapshot[]): string {
  const candidates = group.flatMap((entry) => [
    entry.questionLabel,
    entry.containerLabel,
    entry.promptText,
    entry.containerText,
    entry.label
  ]);
  for (const candidate of candidates) {
    const cleaned = cleanDateGroupLabelCandidate(candidate || "");
    if (cleaned && !isGenericDateLabel(cleaned)) return cleaned;
  }
  const sample = group[0];
  return normalizeText(sample?.questionLabel || sample?.containerLabel || sample?.label || "Date");
}

function deriveChoiceGroupLabel(group: WorkdayControlSnapshot[]): string {
  const optionLabels = Array.from(new Set(
    group
      .map((entry) => normalizeText(entry.optionLabel || entry.label || ""))
      .filter(Boolean)
  ));
  const normalizedOptions = optionLabels.map((value) => value.toLowerCase());
  const isOptionOnlyValue = (value: string): boolean => {
    const normalized = normalizeText(value).toLowerCase();
    return Boolean(normalized) && (
      normalizedOptions.includes(normalized) ||
      normalized === normalizedOptions.join("") ||
      normalized === normalizedOptions.join(" ")
    );
  };
  const cleanContainerCandidate = (value: string): string => {
    const normalized = normalizeText(value);
    if (!normalized) return "";
    let best = normalized;
    let cutIndex = normalized.length;
    for (const option of optionLabels) {
      const idx = normalized.toLowerCase().indexOf(option.toLowerCase());
      if (idx > 0 && idx < cutIndex) cutIndex = idx;
    }
    if (cutIndex < normalized.length) {
      best = normalizeText(normalized.slice(0, cutIndex));
    }
    return best.replace(/\s*\*+\s*$/, "").trim();
  };

  const directCandidates = group.flatMap((entry) => [
    entry.questionLabel,
    entry.containerLabel,
    entry.promptText
  ]);
  for (const candidate of directCandidates) {
    const normalized = normalizeText(candidate || "");
    if (!normalized || isOptionOnlyValue(normalized) || isGenericDateLabel(normalized)) continue;
    return normalized;
  }

  const containerCandidates = group.flatMap((entry) => [entry.containerText]);
  for (const candidate of containerCandidates) {
    const cleaned = cleanContainerCandidate(candidate || "");
    if (!cleaned || isOptionOnlyValue(cleaned) || isGenericDateLabel(cleaned)) continue;
    return cleaned;
  }

  const sample = group[0];
  return normalizeText(sample?.questionLabel || sample?.containerLabel || sample?.promptText || sample?.label || "Choice");
}

function deriveDateSectionGroupKey(snapshot: WorkdayControlSnapshot): string {
  if (snapshot.dateGroupKey) return snapshot.dateGroupKey;
  const fromId = normalizeText(snapshot.id || "").replace(/-dateSection(?:Month|Day|Year)-input$/i, "");
  if (fromId && fromId !== normalizeText(snapshot.id || "")) return fromId;
  return "";
}

function isFileUploadHelperSnapshot(snapshot: WorkdayControlSnapshot): boolean {
  const key = normalizeText([
    snapshot.dataAutomationId,
    snapshot.id,
    snapshot.inputName,
    snapshot.label,
    snapshot.questionLabel,
    snapshot.containerLabel,
    snapshot.containerText
  ].join(" ")).toLowerCase();
  return (
    snapshot.inputType.toLowerCase() === "file" ||
    /file-upload-input-ref|select-files|choose-file|delete-file|remove-file|upload-icon|upload a file|resumeattachments|drop files here/.test(key)
  );
}

function deriveFileUploadLabel(group: WorkdayControlSnapshot[]): string {
  const candidates = group.flatMap((entry) => [
    entry.containerText,
    entry.promptText,
    entry.containerLabel,
    entry.questionLabel,
    entry.label
  ]);
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate || "");
    if (!normalized) continue;
    if (/resume\s*\/\s*cv|resume|curriculum vitae|\bcv\b/i.test(normalized)) return "Resume / CV";
  }
  const sample = group[0];
  return normalizeText(sample?.containerLabel || sample?.questionLabel || sample?.label || "Upload a file");
}

function parseUploadedFileEvidence(group: WorkdayControlSnapshot[]): { currentValue: string | null; uploaded: boolean } {
  const combinedText = normalizeText(group.map((entry) => entry.containerText || "").join(" "));
  const trailingFilenameCandidates = Array.from(new Set(
    combinedText.match(/[a-z0-9][a-z0-9._() -]*\.[a-z0-9]{2,6}(?=\s*(?:successfully uploaded|uploaded|delete|remove|$))/gi)
      ?.map((value) => normalizeText(value)) || []
  ));
  if (trailingFilenameCandidates.length > 0) {
    const trailingFilename = [...trailingFilenameCandidates]
      .map((value) => normalizeText(
        (value.match(/([a-z0-9][\w(). -]*\.[a-z0-9]{2,6})$/i)?.[1] || value)
          .replace(/.*(?:drop files here|select files|upload a file \(5mb max\)|resume\s*\/\s*cv|resume|cv)\s+/i, "")
      ))
      .sort((left, right) => left.length - right.length)[0];
    if (trailingFilename) return { currentValue: trailingFilename, uploaded: true };
  }
  const compactFilenames = Array.from(new Set(
    combinedText.match(/\b[a-z0-9][a-z0-9._() -]*\.[a-z0-9]{2,6}\b/gi)?.map((value) => normalizeText(value)) || []
  ));
  if (compactFilenames.length > 0) {
    const preferredCompact = [...compactFilenames]
      .sort((left, right) => left.length - right.length)
      .find((value) => !/\b(cv|resume|upload|select|drop files here)\b/i.test(value)) || compactFilenames[compactFilenames.length - 1];
    const cleanedCompact = normalizeText(preferredCompact || "")
      .replace(/^.*?(?:resume\s*\/\s*cv|resume|cv|upload a file \(5mb max\)|drop files here|select files)\s*/i, "")
      .trim();
    const trailingFilename = cleanedCompact.match(/([a-z0-9][\w(). -]*\.[a-z0-9]{2,6})$/i);
    return { currentValue: normalizeText(trailingFilename?.[1] || cleanedCompact || preferredCompact || "") || null, uploaded: true };
  }
  const filenames = Array.from(new Set(
    combinedText.match(/\b[\w(). -]+\.[a-z0-9]{2,6}\b/gi)?.map((value) => {
      const normalized = normalizeText(value);
      const filename = normalized.match(/([a-z0-9][\w(). -]*\.[a-z0-9]{2,6})$/i);
      return normalizeText(filename?.[1] || normalized);
    }) || []
  ));
  if (filenames.length > 0) return { currentValue: filenames[0] || null, uploaded: true };
  const hasUploadSuccess = /successfully uploaded|uploaded/i.test(combinedText);
  const hasDeleteOrRemove = group.some((entry) => /delete-file|remove-file/.test((entry.dataAutomationId || "").toLowerCase()));
  if (hasUploadSuccess || hasDeleteOrRemove) return { currentValue: "uploaded", uploaded: true };
  return { currentValue: null, uploaded: false };
}

function hasAny(locator: Locator): Promise<boolean> {
  return locator.count().then((n) => n > 0).catch(() => false);
}

/**
 * True when a matching element is on the page and laid out.
 *
 * Playwright's isVisible() reports false for everything inside a browser view
 * the host has marked not visible, which is exactly how the desktop app runs
 * automations in the background. Step detection then saw an empty page and
 * concluded the application was not ready. Fall back to the element's own
 * layout box, which is computed regardless of whether the view is being drawn.
 */
/**
 * Lenient visibility.
 *
 * Workday nests its step containers so that the container's own box often
 * collapses to zero while its children are laid out and interactive. Strict
 * Playwright visibility calls that hidden, so anything choosing a container has
 * to use this. Anything later re-checking that choice has to use it too, or the
 * two disagree about the same element and the run dies on a page that is fine.
 */
export async function hasVisibleWorkdayContainer(locator: Locator): Promise<boolean> {
  return hasVisible(locator);
}

async function hasVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) return true;
    const laidOut = await candidate
      .evaluate((node) => {
        const element = node as HTMLElement;
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        if (style && (style.display === "none" || style.visibility === "hidden")) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) return true;
        // A container whose own box collapsed still counts when it has laid-out
        // children, which is common for step wrappers.
        return Array.from(element.children).some((child) => {
          const childRect = (child as HTMLElement).getBoundingClientRect();
          return childRect.width > 0 || childRect.height > 0;
        });
      })
      .catch(() => false);
    if (laidOut) return true;
  }
  return false;
}

const STEP_CONTAINER_SELECTORS: Partial<Record<WorkdayStep, string[]>> = {
  contact_information: ["div[data-automation-id='contactInformationPage']", "div[data-automation-id='applyFlowMyInfoPage']"],
  my_experience: ["div[data-automation-id='myExperiencePage']", "main", "form"],
  application_questions: [
    "div[data-automation-id='applyFlowPrimaryQuestionsPage']",
    "div[data-automation-id*='PrimaryQuestionsPage']",
    "div[data-automation-id*='QuestionnairePage']",
    "div[data-automation-id*='Questionnaire']",
    "div[role='group']",
    "main"
  ],
  voluntary_disclosures: ["div[data-automation-id='voluntaryDisclosuresPage']"],
  self_identification: ["div[data-automation-id='selfIdentificationPage']"]
};

export const STEP_VISIBLE_MARKERS: Partial<Record<WorkdayStep, string[]>> = {
  contact_information: [
    "div[data-automation-id='contactInformationPage']",
    "div[data-automation-id='applyFlowMyInfoPage']"
  ],
  my_experience: [
    "div[data-automation-id='myExperiencePage']",
    "h2:has-text('My Experience')",
    "h3:has-text('My Experience')",
    "[data-automation-id='workExperienceSection']",
    "[data-automation-id='educationSection']",
    "[data-automation-id='select-files']"
  ],
  application_questions: [
    "div[data-automation-id='applyFlowPrimaryQuestionsPage']",
    "div[data-automation-id*='PrimaryQuestionsPage']",
    "div[data-automation-id*='QuestionnairePage']",
    "div[data-automation-id*='Questionnaire']",
    "h2:has-text('Application Questions')",
    "h3:has-text('Application Questions')"
  ],
  voluntary_disclosures: [
    "div[data-automation-id='voluntaryDisclosuresPage']",
    "h2:has-text('Voluntary Disclosures')",
    "h3:has-text('Voluntary Disclosures')"
  ],
  self_identification: [
    "div[data-automation-id='selfIdentificationPage']",
    "h2:has-text('Self Identify')",
    "h3:has-text('Self Identify')",
    "h2:has-text('Self Identification')",
    "h3:has-text('Self Identification')"
  ],
  take_assessment: [
    "button:has-text('Take Assessment')",
    "h1:has-text('Take Assessment')",
    "h2:has-text('Take Assessment')",
    "h3:has-text('Take Assessment')"
  ],
  review: [
    "div[data-automation-id='reviewPage']",
    "div[data-automation-id*='reviewPage']",
    "div[data-automation-id*='applicationReview']",
    "h1:has-text('Review')",
    "h2:has-text('Review')",
    "h3:has-text('Review')",
    "h1:has-text('Summary')",
    "h2:has-text('Summary')",
    "h3:has-text('Summary')"
  ],
  submit: [
    "button[data-automation-id*='submit']",
    "button:has-text('Submit')",
    "button:has-text('Review and Submit')"
  ]
};

async function hasAnyVisibleMarker(page: Page, step: WorkdayStep): Promise<boolean> {
  const markers = STEP_VISIBLE_MARKERS[step] ?? [];
  for (const marker of markers) {
    if (await hasVisible(page.locator(marker))) return true;
  }
  return false;
}

export async function hasVisibleWorkdayApplicationShell(page: Page): Promise<boolean> {
  return hasVisible(page.locator("div[data-automation-id='applyFlowPage']"));
}

export async function resolveActiveWorkdayContainerSelector(page: Page, step: WorkdayStep): Promise<string> {
  const candidates = STEP_CONTAINER_SELECTORS[step] ?? [];
  for (const selector of candidates) {
    if (await hasVisible(page.locator(selector))) return selector;
  }
  if (step === "application_questions" && await hasVisible(page.locator("main"))) {
    return "main";
  }
  for (const fallbackSelectors of Object.values(STEP_CONTAINER_SELECTORS)) {
    for (const selector of fallbackSelectors ?? []) {
      if (await hasVisible(page.locator(selector))) return selector;
    }
  }
  return "main, form, body";
}

const APPLICATION_QUESTION_CONTAINER_SELECTORS = [
  "div[data-automation-id='applyFlowPrimaryQuestionsPage']",
  "div[data-automation-id*='PrimaryQuestionsPage']",
  "div[data-automation-id*='QuestionnairePage']",
  "div[data-automation-id*='Questionnaire']",
  "main"
] as const;

const APPLICATION_QUESTION_CANDIDATE_SELECTOR = [
  "div[data-automation-id^='formField-']",
  "[data-fkit-id*='primaryQuestionnaire']",
  "fieldset",
  "div:has(button[aria-haspopup='listbox'])",
  "div:has([aria-label*='Required'])",
  "div:has(abbr[title='required'])",
  "div:has(.requiredAsterisk)"
].join(", ");

function detectFieldTypeFromWidget(widget: WorkdayWidgetSchema): WorkdayFieldType {
  switch (widget.widgetType) {
    case "text_input":
      return "text";
    case "textarea":
      return "textarea";
    case "button_select":
      return "dropdown";
    case "prompt_input_select":
      return "search_combobox";
    case "radio_group":
      return "radio";
    case "checkbox_group":
      return "checkbox";
    case "date_mm_yyyy":
    case "date_mm_dd_yyyy":
      return "date_month_year";
    case "file_upload":
      return "file";
    case "panel_collection":
      return "panel_collection";
    default:
      return "unknown";
  }
}

function buildWidgetId(snapshot: WorkdayControlSnapshot, fallbackIndex: number): string {
  const base = normalizeText([
    snapshot.dataAutomationId,
    snapshot.id,
    snapshot.inputName,
    snapshot.containerKey,
    snapshot.questionLabel,
    snapshot.rawKey
  ].filter(Boolean).join(" "));
  return base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "") || `workday_widget_${fallbackIndex}`;
}

function inferWidgetType(snapshot: WorkdayControlSnapshot): WorkdayWidgetType {
  if (snapshot.kind === "panel") return "panel_collection";

  const tag = snapshot.tag.toLowerCase();
  const inputType = snapshot.inputType.toLowerCase();
  const role = snapshot.role.toLowerCase();
  const haspopup = snapshot.ariaHaspopup.toLowerCase();
  const key = `${snapshot.dataAutomationId} ${snapshot.id} ${snapshot.questionLabel} ${snapshot.label}`.toLowerCase();
  const fieldOfStudyKey = `${snapshot.questionLabel} ${snapshot.label} ${snapshot.dataAutomationId} ${snapshot.id} ${snapshot.inputName} ${snapshot.containerText}`.toLowerCase();

  if (inputType === "file" || /file-upload-input-ref/.test(snapshot.dataAutomationId)) return "file_upload";
  if (inputType === "radio") return "radio_group";
  if (inputType === "checkbox") return "checkbox_group";
  const dateGroupKey = deriveDateSectionGroupKey(snapshot);
  if (dateGroupKey) {
    if (snapshot.sectionCount === 2) return "date_mm_yyyy";
    if (snapshot.sectionCount === 3) return "date_mm_dd_yyyy";
  }
  if (tag === "select") return "unknown";
  if (tag === "textarea") return "textarea";
  if (haspopup === "listbox") return "button_select";
  if (
    /field of study|major|discipline|area of study|fieldofstudy/.test(fieldOfStudyKey) &&
    (
      /fieldofstudy|prompt|searchbox|multiselect|selecteditemlist|promptsearchbutton/.test(fieldOfStudyKey) ||
      /\bitem selected\b/.test(fieldOfStudyKey)
    )
  ) {
    return "prompt_input_select";
  }
  if (
    /type to add skills|skills/.test(fieldOfStudyKey) &&
    (
      /skills|prompt|searchbox|multiselect|selecteditemlist|promptsearchbutton/.test(fieldOfStudyKey) ||
      /\bitem selected\b/.test(fieldOfStudyKey)
    )
  ) {
    return "prompt_input_select";
  }
  if (role === "combobox" || /prompt|search|source|countryphonecode/.test(key)) return "prompt_input_select";
  if (tag === "input" && ["text", "email", "tel", "number", ""].includes(inputType)) return "text_input";
  return "unknown";
}

function makeLegacyField(widget: WorkdayWidgetSchema): WorkdayFieldSchema {
  return {
    fieldId: widget.widgetId,
    label: widget.label,
    required: widget.required,
    fieldType: detectFieldTypeFromWidget(widget),
    possibleAnswers: widget.options,
    currentValue: widget.currentValue,
    selectorHints: {
      id: widget.selectorHints.id,
      dataAutomationId: widget.selectorHints.dataAutomationId,
      role: widget.selectorHints.role,
      inputName: widget.selectorHints.inputName,
      selector: widget.selectorHints.controlSelector || widget.selectorHints.containerSelector
    },
    step: widget.step,
    htmlSummary: widget.htmlSummary
  };
}

function stableGroupKey(snapshot: WorkdayControlSnapshot, suffix: string): string {
  const dateGroupKey = deriveDateSectionGroupKey(snapshot);
  if (dateGroupKey) {
    return [
      dateGroupKey,
      suffix
    ].filter(Boolean).join("::");
  }
  return [
    snapshot.containerKey,
    snapshot.questionLabel || snapshot.label,
    snapshot.inputName,
    snapshot.dateGroupKey,
    suffix
  ].filter(Boolean).join("::");
}

function firstTruthy<T>(...values: Array<T | undefined | null | false | "">): T | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}

export function buildWorkdayWidgetsFromControls(controls: WorkdayControlSnapshot[], step: WorkdayStep): WorkdayWidgetSchema[] {
  const widgets: WorkdayWidgetSchema[] = [];
  const seen = new Set<string>();
  let fallbackIndex = 0;

  const panelSnapshots = controls.filter((control) => control.kind === "panel");
  for (const snapshot of panelSnapshots) {
    const widgetId = buildWidgetId(snapshot, fallbackIndex += 1);
    if (seen.has(widgetId)) continue;
    seen.add(widgetId);
    widgets.push({
      widgetId,
      step,
      label: normalizeText(snapshot.questionLabel || snapshot.label || snapshot.containerLabel || snapshot.dataAutomationId || widgetId),
      widgetType: "panel_collection",
      options: [],
      currentValue: snapshot.panelItemPrefixes?.length ? [String(snapshot.panelItemPrefixes.length)] : null,
      required: snapshot.required,
      promptText: normalizeText(snapshot.promptText || snapshot.containerText || snapshot.questionLabel || snapshot.label),
      visibleContainerId: snapshot.visibleContainerId,
      selectorHints: {
        controlSelector: snapshot.selector || undefined,
        containerSelector: snapshot.selector || undefined,
        dataAutomationId: snapshot.dataAutomationId || undefined,
        addButtonSelector: snapshot.addButtonSelector,
        rowPrefixFieldSuffix: snapshot.rowPrefixFieldSuffix,
        panelItemPrefixes: snapshot.panelItemPrefixes || []
      },
      htmlSummary: {
        ...(snapshot.htmlSummary || {}),
        panelKind: snapshot.dataAutomationId
      }
    });
  }

  const usedKeys = new Set<string>();

  const fileGroups = new Map<string, WorkdayControlSnapshot[]>();
  for (const control of controls.filter((entry) => entry.kind === "control" && isFileUploadHelperSnapshot(entry))) {
    const key = stableGroupKey(control, "file_upload");
    const list = fileGroups.get(key) || [];
    list.push(control);
    fileGroups.set(key, list);
  }
  for (const [key, group] of fileGroups.entries()) {
    for (const entry of group) usedKeys.add(entry.rawKey);
    const sample = group[0]!;
    const fileInput = group.find((entry) => entry.inputType.toLowerCase() === "file" || /file-upload-input-ref/.test(entry.dataAutomationId));
    const controlWithSelector = group.find((entry) => Boolean(entry.selector));
    const { currentValue, uploaded } = parseUploadedFileEvidence(group);
    widgets.push({
      widgetId: buildWidgetId({ ...sample, rawKey: key }, fallbackIndex += 1),
      step,
      label: deriveFileUploadLabel(group),
      widgetType: "file_upload",
      options: [],
      currentValue,
      required: group.some((entry) => entry.required),
      promptText: normalizeText(sample.promptText || sample.containerText || sample.questionLabel || sample.label),
      visibleContainerId: sample.visibleContainerId,
      selectorHints: {
        containerSelector: controlWithSelector?.selector || undefined,
        controlSelector: controlWithSelector?.selector || undefined,
        fileInputSelector: fileInput?.selector || undefined,
        dataAutomationId: sample.dataAutomationId || undefined
      },
      htmlSummary: {
        groupKey: key,
        uploadedEvidence: uploaded,
        uploadedFilename: currentValue || "",
        helpers: group.map((entry) => entry.dataAutomationId || entry.id || entry.label).filter(Boolean)
      }
    });
  }

  const dateGroups = new Map<string, WorkdayControlSnapshot[]>();
  for (const control of controls.filter((entry) => entry.kind === "control" && deriveDateSectionGroupKey(entry))) {
    const key = stableGroupKey(control, "date");
    const list = dateGroups.get(key) || [];
    list.push(control);
    dateGroups.set(key, list);
  }
  for (const [key, group] of dateGroups.entries()) {
    if (group.length < 2) continue;
    for (const entry of group) usedKeys.add(entry.rawKey);
    const sample = group[0]!;
    const month = group.find((entry) => /month/i.test(entry.id) || /month/i.test(entry.label));
    const day = group.find((entry) => /day/i.test(entry.id) || /day/i.test(entry.label));
    const year = group.find((entry) => /year/i.test(entry.id) || /year/i.test(entry.label));
    const currentValue = [
      month?.currentValue ? String(month.currentValue) : "",
      day?.currentValue ? String(day.currentValue) : "",
      year?.currentValue ? String(year.currentValue) : ""
    ].filter(Boolean);
    widgets.push({
      widgetId: buildWidgetId({ ...sample, rawKey: key }, fallbackIndex += 1),
      step,
      label: deriveDateGroupLabel(group),
      widgetType: (sample.sectionCount || group.length) === 2 ? "date_mm_yyyy" : "date_mm_dd_yyyy",
      options: [],
      currentValue: currentValue.length ? currentValue : null,
      required: group.some((entry) => entry.required) || /\*/.test(deriveDateGroupLabel(group)),
      promptText: normalizeText(deriveDateGroupLabel(group) || sample.promptText || sample.containerText || sample.questionLabel || sample.label),
      visibleContainerId: sample.visibleContainerId,
      selectorHints: {
        containerSelector: firstTruthy(sample.selector, sample.selector),
        controlSelector: firstTruthy(month?.selector, day?.selector, year?.selector),
        monthSelector: month?.selector,
        daySelector: day?.selector,
        yearSelector: year?.selector,
        dataAutomationId: sample.dataAutomationId || undefined
      },
      htmlSummary: {
        groupKey: key,
        sectionCount: sample.sectionCount || group.length
      }
    });
  }

  const choiceGroups = new Map<string, WorkdayControlSnapshot[]>();
  for (const control of controls.filter((entry) => entry.kind === "control" && (entry.inputType === "radio" || entry.inputType === "checkbox"))) {
    const key = stableGroupKey(control, control.inputType);
    const list = choiceGroups.get(key) || [];
    list.push(control);
    choiceGroups.set(key, list);
  }
  for (const [key, group] of choiceGroups.entries()) {
    for (const entry of group) usedKeys.add(entry.rawKey);
    const sample = group[0]!;
    const optionSelectors: Record<string, string> = {};
    const options = Array.from(new Set(group.map((entry) => normalizeText(entry.optionLabel || entry.label || String(entry.currentValue || ""))).filter(Boolean)));
    const groupLabel = deriveChoiceGroupLabel(group);
    for (const entry of group) {
      const label = normalizeText(entry.optionLabel || entry.label || "");
      if (label && entry.optionSelector) optionSelectors[label] = entry.optionSelector;
    }
    const selected = group
      .filter((entry) => entry.currentValue === "checked")
      .map((entry) => normalizeText(entry.optionLabel || entry.label || String(entry.currentValue || "")))
      .filter(Boolean);
    widgets.push({
      widgetId: buildWidgetId({ ...sample, rawKey: key }, fallbackIndex += 1),
      step,
      label: groupLabel,
      widgetType: sample.inputType === "radio" ? "radio_group" : "checkbox_group",
      options,
      currentValue: selected.length ? selected : null,
      required: group.some((entry) => entry.required),
      promptText: normalizeText(groupLabel || sample.promptText || sample.containerText || sample.questionLabel || sample.label),
      visibleContainerId: sample.visibleContainerId,
      selectorHints: {
        containerSelector: firstTruthy(sample.optionSelector, sample.selector),
        controlSelector: firstTruthy(sample.optionSelector, sample.selector),
        optionSelectors,
        dataAutomationId: sample.dataAutomationId || undefined,
        inputName: sample.inputName || undefined
      },
      htmlSummary: {
        groupKey: key,
        inputType: sample.inputType
      }
    });
  }

  for (const snapshot of controls.filter((entry) => entry.kind === "control" && !usedKeys.has(entry.rawKey))) {
    const widgetType = inferWidgetType(snapshot);
    if (snapshot.dataAutomationId === "dateIcon") continue;
    if (!snapshot.selector && widgetType !== "panel_collection") continue;
    const widgetId = buildWidgetId(snapshot, fallbackIndex += 1);
    if (seen.has(widgetId)) continue;
    seen.add(widgetId);
    widgets.push({
      widgetId,
      step,
      label: normalizeText(snapshot.questionLabel || snapshot.label || snapshot.containerLabel || snapshot.dataAutomationId || widgetId),
      widgetType,
      options: [],
      currentValue: snapshot.currentValue,
      required: snapshot.required,
      promptText: normalizeText(snapshot.promptText || snapshot.containerText || snapshot.questionLabel || snapshot.label),
      visibleContainerId: snapshot.visibleContainerId,
      selectorHints: {
        controlSelector: snapshot.selector || undefined,
        containerSelector: snapshot.selector || undefined,
        id: snapshot.id || undefined,
        dataAutomationId: snapshot.dataAutomationId || undefined,
        role: snapshot.role || undefined,
        inputName: snapshot.inputName || undefined,
        fileInputSelector: widgetType === "file_upload" ? snapshot.selector || undefined : undefined
      },
      htmlSummary: snapshot.htmlSummary || {
        tag: snapshot.tag,
        inputType: snapshot.inputType,
        role: snapshot.role,
        dataAutomationId: snapshot.dataAutomationId
      }
    });
  }

  return widgets;
}

async function extractNativeSelectOptions(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((controlSelector) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const select = document.querySelector(controlSelector) as HTMLSelectElement | null;
    if (!select) return [];
    return Array.from(select.options)
      .map((option) => normalize(option.textContent || option.value || ""))
      .filter((option) => option && !/^select one$/i.test(option));
  }, selector).catch(() => [] as string[]);
}

async function extractScopedOpenOptions(page: Page, triggerSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const trigger = document.querySelector(selector) as HTMLElement | null;
    const active = document.activeElement as HTMLElement | null;
    const ids = [
      trigger?.getAttribute("aria-controls") || "",
      trigger?.getAttribute("aria-owns") || "",
      active?.getAttribute("aria-controls") || "",
      active?.getAttribute("aria-owns") || ""
    ].map((value) => normalize(value)).filter(Boolean);

    const optionNodesFor = (root: ParentNode | null): HTMLElement[] => {
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>("[role='option'], [data-automation-id='promptOption'], [role='menuitemradio'], [role='menuitemcheckbox']"))
        .filter((node) => visible(node));
    };

    const containers: HTMLElement[] = [];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (visible(node)) containers.push(node);
    }
    for (const candidate of Array.from(document.querySelectorAll<HTMLElement>("[role='listbox'], [role='dialog'], [data-automation-id='promptOption']"))) {
      if (!visible(candidate)) continue;
      if (candidate.getAttribute("role") === "listbox" || candidate.getAttribute("data-automation-id") === "promptOption") {
        containers.push(candidate);
      } else if (candidate.querySelector("[role='option'], [data-automation-id='promptOption']")) {
        containers.push(candidate);
      }
    }

    const triggerRect = trigger?.getBoundingClientRect();
    const ranked = containers
      .map((container) => {
        const rect = container.getBoundingClientRect();
        const distance = triggerRect
          ? Math.abs(rect.left - triggerRect.left) + Math.abs(rect.top - triggerRect.bottom)
          : 0;
        const count = optionNodesFor(container).length;
        return { container, distance, count };
      })
      .filter((entry) => entry.count > 0)
      .sort((a, b) => a.distance - b.distance || b.count - a.count);

    const root = ranked[0]?.container || null;
    if (!root) return [];
    const optionNodes = optionNodesFor(root);
    const extracted = optionNodes.map((node) => {
      return normalize(node.textContent || node.getAttribute("aria-label") || "");
    });

    return Array.from(new Set(extracted.filter((value) => (
      value &&
      !/^select one$/i.test(value) &&
      !/^all$/i.test(value) &&
      !/^no items\.?$/i.test(value)
    ))));
  }, triggerSelector).catch(() => [] as string[]);
}

/**
 * How hard to work to discover a widget's options.
 *
 * "native" is a DOM read and costs nothing. "full" also opens each custom
 * dropdown to see what is inside, which means a click, a wait and an Escape per
 * widget -- affordable on the two steps that are mostly dropdowns, wasteful
 * everywhere else.
 */
type WorkdayOptionHydration = "native" | "full";

async function hydrateWorkdayWidgetOptions(
  page: Page,
  widget: WorkdayWidgetSchema,
  depth: WorkdayOptionHydration = "full"
): Promise<WorkdayWidgetSchema> {
  if (widget.options.length > 0) return widget;
  const selector = widget.selectorHints.controlSelector || widget.selectorHints.containerSelector;
  if (!selector) return widget;

  const htmlTag = String(widget.htmlSummary.tag || "").toLowerCase();
  if (htmlTag === "select") {
    const options = sanitizeHydratedWidgetOptions(widget, await extractNativeSelectOptions(page, selector));
    if (options.length) return { ...widget, options };
    return widget;
  }

  if (depth === "native") return widget;

  if (widget.widgetType !== "button_select" && widget.widgetType !== "prompt_input_select") {
    return widget;
  }

  const trigger = page.locator(selector).first();
  const visible = await trigger.isVisible().catch(() => false);
  if (!visible) return widget;

  await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
  await trigger.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(220);
  const options = sanitizeHydratedWidgetOptions(widget, await extractScopedOpenOptions(page, selector));
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(80);
  if (!options.length) return widget;
  return { ...widget, options };
}

export async function detectWorkdayStep(page: Page): Promise<WorkdayStep> {
  if (await hasVisible(page.locator("input[data-automation-id='verifyPassword']"))) return "create_account";
  if (await hasVisible(page.locator("button[data-automation-id='signInSubmitButton']"))) return "sign_in";

  if (await hasAnyVisibleMarker(page, "contact_information")) return "contact_information";
  if (await hasAnyVisibleMarker(page, "my_experience")) return "my_experience";
  if (await hasAnyVisibleMarker(page, "application_questions")) return "application_questions";
  if (await hasAnyVisibleMarker(page, "voluntary_disclosures")) return "voluntary_disclosures";
  if (await hasAnyVisibleMarker(page, "self_identification")) return "self_identification";
  if (await hasAnyVisibleMarker(page, "take_assessment")) return "take_assessment";
  if (await hasAnyVisibleMarker(page, "submit")) return "submit";
  if (await hasAnyVisibleMarker(page, "review")) return "review";
  if (await hasVisible(page.locator("a[data-automation-id='applyManually'], button[data-automation-id='applyManually'], button:has-text('Apply')"))) return "start";

  return "unknown";
}

export async function isFirstActionableWorkdayStepReady(page: Page, step?: WorkdayStep): Promise<boolean> {
  const currentStep = step ?? await detectWorkdayStep(page);
  if (!["contact_information", "my_experience", "application_questions", "voluntary_disclosures", "self_identification", "take_assessment", "review", "submit"].includes(currentStep)) {
    return false;
  }
  if (await hasAnyVisibleMarker(page, currentStep)) return true;
  const activeContainerSelector = await resolveActiveWorkdayContainerSelector(page, currentStep);
  if (activeContainerSelector === "main, form, body") return false;
  return hasVisible(page.locator(activeContainerSelector));
}

export async function isReviewOrSubmitPage(page: Page): Promise<boolean> {
  const step = await detectWorkdayStep(page);
  return step === "review" || step === "submit";
}

async function extractApplicationQuestionControls(page: Page): Promise<WorkdayControlSnapshot[]> {
  return page.evaluate(({ containerSelectors, candidateSelector }) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cssEscape = (value: string): string => {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (control: HTMLElement, preferInput = false): string => {
      const id = normalize(control.getAttribute("id") || "");
      if (id) return `[id="${id.replace(/"/g, '\\"')}"]`;
      const dataAutomationId = normalize(control.getAttribute("data-automation-id") || "");
      if (dataAutomationId) return `${control.tagName.toLowerCase()}[data-automation-id="${dataAutomationId.replace(/"/g, '\\"')}"]`;
      const name = normalize(control.getAttribute("name") || "");
      if (name) return `${preferInput ? "input" : control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      const ariaLabel = normalize(control.getAttribute("aria-label") || "");
      if (ariaLabel) return `${control.tagName.toLowerCase()}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
      return "";
    };
    const isGenericDateLabel = (value: string): boolean => /^(mm|dd|yyyy|month|day|year|mm\/yyyy|mm\/dd\/yyyy)$/i.test(normalize(value));
    const cleanDateLabelCandidate = (value: string): string => normalize(
      String(value ?? "")
        .replace(/\b(?:mm\/dd\/yyyy|mm\/yyyy)\b/gi, " ")
        .replace(/\b(?:mm|dd|yyyy|month|day|year)\b/gi, " ")
    );
    const isNavigationControl = (control: HTMLElement, questionLabel: string): boolean => {
      const tag = control.tagName.toLowerCase();
      const dataAutomationId = normalize(control.getAttribute("data-automation-id") || "");
      const ariaLabel = normalize(control.getAttribute("aria-label") || "");
      const role = normalize(control.getAttribute("role") || "");
      const key = `${dataAutomationId} ${questionLabel} ${ariaLabel} ${role}`.toLowerCase();
      if (!key) return false;
      if (/backtojobposting|pagefooternextbutton|bottom-navigation-next-button|signin|createaccount|applymanually|adventurebutton/.test(key)) return true;
      if (tag !== "input" && /(back to job|apply manually|start application|sign in|create account|save and continue|^continue$|^next$|^submit$)/.test(key)) return true;
      return false;
    };
    const resolvedRoot = (() => {
      for (const selector of containerSelectors) {
        const node = document.querySelector(selector);
        if (visible(node)) return { selector, node };
      }
      const main = document.querySelector("main");
      if (visible(main)) return { selector: "main", node: main };
      return { selector: "body", node: document.body };
    })();
    const root = resolvedRoot.node;
    const rawCandidates = Array.from(root.querySelectorAll(candidateSelector))
      .filter((node): node is HTMLElement => visible(node));
    const candidateNodes = rawCandidates.filter((node, index, nodes) => !nodes.some((other, otherIndex) => otherIndex !== index && other.contains(node)));
    const textExcludingControls = (container: HTMLElement): string => {
      const clone = container.cloneNode(true) as HTMLElement;
      for (const node of Array.from(clone.querySelectorAll("button, input, textarea, select, [role='button'], [role='combobox'], [role='listbox'], svg, path"))) {
        node.remove();
      }
      return normalize(clone.textContent || "");
    };
    const textFromIds = (ids: string): string => {
      return normalize(ids.split(/\s+/).map((id) => {
        const el = document.getElementById(id);
        return normalize(el?.textContent || "");
      }).filter(Boolean).join(" "));
    };
    const labelFromContainer = (container: HTMLElement, control?: HTMLElement | null): string => {
      const controlIds = normalize(control?.getAttribute("aria-labelledby") || "");
      const containerIds = normalize(container.getAttribute("aria-labelledby") || "");
      return normalize(
        container.querySelector("legend")?.textContent ||
        container.querySelector("[data-automation-id='formLabel']")?.textContent ||
        container.querySelector("[data-automation-id*='formLabel']")?.textContent ||
        container.querySelector("[data-automation-id*='richText']")?.textContent ||
        (controlIds ? textFromIds(controlIds) : "") ||
        (containerIds ? textFromIds(containerIds) : "") ||
        textExcludingControls(container)
      );
    };
    const deriveQuestionLabelFromAria = (control: HTMLElement): string => {
      const aria = normalize(control.getAttribute("aria-label") || "");
      if (!aria) return "";
      let derived = aria
        .replace(/\brequired\b/gi, " ")
        .replace(/\bcurrent value is\b.*$/i, " ")
        .trim();
      const ownText = normalize(control.textContent || "");
      if (ownText) {
        derived = derived.replace(new RegExp(`\\b${escapeRegExp(ownText)}\\b`, "ig"), " ").trim();
      }
      derived = normalize(derived).replace(/[:*]+$/g, "").trim();
      return derived;
    };
    const isRequired = (container: HTMLElement, control?: HTMLElement | null, label = ""): boolean => {
      const combined = `${label} ${normalize(control?.getAttribute("aria-label") || "")}`.trim();
      return Boolean(
        control?.hasAttribute("required") ||
        control?.getAttribute("aria-required") === "true" ||
        container.querySelector(".requiredAsterisk") ||
        container.querySelector("abbr[title='required']") ||
        container.querySelector("[aria-label*='Required']") ||
        /\*/.test(combined)
      );
    };
    const fieldContainerFor = (control: HTMLElement): HTMLElement => {
      const structural = control.closest("[data-automation-id^='formField-'], [data-fkit-id*='primaryQuestionnaire'], fieldset, [role='group']");
      if (visible(structural)) return structural;
      let best: HTMLElement | null = null;
      for (const candidate of candidateNodes) {
        if (!candidate.contains(control)) continue;
        if (!best || best.contains(candidate)) best = candidate;
      }
      return best || control.closest("fieldset, [data-automation-id^='formField-'], [data-fkit-id*='primaryQuestionnaire'], [role='group'], section, div") || control.parentElement || root;
    };
    const inheritedDateQuestionLabel = (control: HTMLElement, fieldContainer: HTMLElement): string => {
      const roots = [
        fieldContainer,
        fieldContainer.parentElement,
        fieldContainer.closest("[role='group']"),
        fieldContainer.closest("fieldset"),
        control.closest("section"),
        control.parentElement?.closest("[data-automation-id^='formField-']"),
        control.parentElement?.closest("[role='group']")
      ].filter((node): node is HTMLElement => node instanceof HTMLElement);
      for (const currentRoot of roots) {
        const candidates = Array.from(currentRoot.querySelectorAll("legend, [data-automation-id='formLabel'], [data-automation-id*='formLabel'], [data-automation-id*='richText'], label, h1, h2, h3, h4, h5"))
          .map((node) => cleanDateLabelCandidate(node.textContent || ""))
          .filter((text) => text && !isGenericDateLabel(text));
        if (candidates.length) return candidates[0] || "";
      }
      return "";
    };
    const promptCurrentValue = (control: HTMLElement, fieldContainer: HTMLElement): string | null => {
      const container = control.closest("[data-automation-id='multiSelectContainer'], [data-automation-id='multiselectInputContainer'], [data-automation-id^='formField-'], [data-automation-id*='formField']") as HTMLElement | null;
      const selectedTexts = Array.from((container || fieldContainer).querySelectorAll<HTMLElement>("[data-automation-id='selectedItem'], [data-automation-id='selectedItemList'] [data-automation-id='promptOption'], [data-automation-id='selectedItemList'] [role='option']"))
        .map((node) => normalize(node.textContent || node.getAttribute("aria-label") || ""))
        .filter(Boolean);
      if (selectedTexts.length) return Array.from(new Set(selectedTexts)).join(" / ");
      const promptInstruction = normalize((container || fieldContainer).querySelector<HTMLElement>("[data-automation-id='promptAriaInstruction']")?.textContent || "");
      const promptSelection = normalize((container || fieldContainer).querySelector<HTMLElement>("[data-automation-id='promptSelectionLabel']")?.textContent || "");
      const promptValue = promptSelection || promptInstruction.replace(/^\d+\s+items?\s+selected,\s*/i, "").trim();
      return promptValue || null;
    };

    const snapshots: WorkdayControlSnapshot[] = [];
    const seen = new Set<string>();
    let index = 0;
    const pushSnapshot = (snapshot: WorkdayControlSnapshot): void => {
      const key = `${snapshot.selector}::${snapshot.questionLabel}::${snapshot.inputName}::${snapshot.optionLabel || ""}`;
      if (!snapshot.selector || !snapshot.questionLabel || seen.has(key)) return;
      seen.add(key);
      snapshots.push(snapshot);
    };

    const controls = Array.from(root.querySelectorAll<HTMLElement>("input, textarea, button, select, [role='combobox'], [role='button']"))
      .filter((control) => visible(control));
    for (const control of controls) {
      const tag = control.tagName.toLowerCase();
      const input = control as HTMLInputElement;
      const inputType = normalize(input.type || "").toLowerCase();
      if (["hidden", "submit", "reset"].includes(inputType)) continue;

      const fieldContainer = fieldContainerFor(control);
      const questionLabel = labelFromContainer(fieldContainer, control) || deriveQuestionLabelFromAria(control);
      if (!questionLabel) continue;
      if (isNavigationControl(control, questionLabel)) continue;

      const dataAutomationId = normalize(control.getAttribute("data-automation-id") || "");
      const role = normalize(control.getAttribute("role") || "");
      const ariaHaspopup = normalize(control.getAttribute("aria-haspopup") || "");
      const inputName = normalize(control.getAttribute("name") || "");
      const id = normalize(control.getAttribute("id") || "");
      const aria = normalize(control.getAttribute("aria-label") || "");
      const ownLabel = id ? normalize(document.querySelector(`label[for="${cssEscape(id)}"]`)?.textContent || "") : "";
      const wrapLabel = normalize(control.closest("label")?.textContent || "");
      const isDateSection = /-dateSection(?:Month|Day|Year)-input$/i.test(id);
      const dateGroupKey = isDateSection ? id.replace(/-dateSection(?:Month|Day|Year)-input$/i, "") : "";
      const sectionCount = dateGroupKey
        ? root.querySelectorAll(`[id^="${dateGroupKey.replace(/"/g, '\\"')}"][id*="-dateSection"][id$="-input"]`).length
        : 0;
      const inheritedQuestionLabel = isDateSection && isGenericDateLabel(questionLabel)
        ? inheritedDateQuestionLabel(control, fieldContainer)
        : "";
      const finalQuestionLabel = inheritedQuestionLabel || questionLabel;
      const controlLabel = ownLabel || wrapLabel || aria || normalize(control.textContent || "") || finalQuestionLabel;
      const required = isRequired(fieldContainer, control, questionLabel);

      let currentValue: string | string[] | null = null;
      if (inputType === "radio" || inputType === "checkbox") {
        currentValue = input.checked ? "checked" : null;
      } else if (tag === "textarea" || tag === "input") {
        const promptValue = promptCurrentValue(control, fieldContainer);
        currentValue = promptValue || normalize((control as HTMLInputElement | HTMLTextAreaElement).value || "") || null;
      } else if (tag === "select") {
        const selected = (control as HTMLSelectElement).selectedOptions?.[0];
        currentValue = normalize(selected?.textContent || (control as HTMLSelectElement).value || "") || null;
      } else {
        currentValue = normalize(control.textContent || aria || "") || null;
      }

      pushSnapshot({
        kind: "control",
        rawKey: `${id || dataAutomationId || inputName || tag}_${index += 1}`,
        tag,
        inputType,
        role,
        ariaHaspopup,
        label: controlLabel,
        questionLabel: finalQuestionLabel,
        required,
        currentValue,
        selector: selectorFor(control, tag === "input"),
        id,
        inputName,
        dataAutomationId,
        containerKey: normalize(fieldContainer.getAttribute("data-automation-id") || fieldContainer.getAttribute("id") || finalQuestionLabel),
        containerLabel: finalQuestionLabel,
        containerText: normalize(fieldContainer.textContent || ""),
        optionLabel: inputType === "radio" || inputType === "checkbox" ? controlLabel : undefined,
        optionSelector: inputType === "radio" || inputType === "checkbox" ? selectorFor(control, true) : undefined,
        promptText: normalize(fieldContainer.textContent || finalQuestionLabel),
        visibleContainerId: normalize(fieldContainer.getAttribute("data-automation-id") || fieldContainer.getAttribute("id") || resolvedRoot.selector),
        dateGroupKey: dateGroupKey || undefined,
        sectionCount: sectionCount || undefined,
        htmlSummary: {
          tag,
          inputType,
          role,
          ariaHaspopup,
          ariaInvalid: control.getAttribute("aria-invalid") === "true",
          hasInputAlert: Boolean(fieldContainer.querySelector("[data-automation-id='inputAlert']")),
          id,
          dataAutomationId,
          extractionRoot: resolvedRoot.selector
        }
      });
    }

    if (snapshots.length === 0) {
      const fallbackButtons = Array.from(root.querySelectorAll<HTMLElement>("button, [role='button']"))
        .filter((button) => visible(button))
        .filter((button) => {
          const text = normalize(button.textContent || "");
          const ariaLabel = normalize(button.getAttribute("aria-label") || "");
          return /select one/i.test(text) || /required/i.test(ariaLabel) || normalize(button.getAttribute("aria-haspopup") || "") === "listbox";
        });

      for (const button of fallbackButtons) {
        const fieldContainer = fieldContainerFor(button);
        const questionLabel = labelFromContainer(fieldContainer, button) || deriveQuestionLabelFromAria(button) || `application_question_${index + 1}`;
        if (isNavigationControl(button, questionLabel)) continue;
        const dataAutomationId = normalize(button.getAttribute("data-automation-id") || "");
        const role = normalize(button.getAttribute("role") || "");
        const ariaHaspopup = normalize(button.getAttribute("aria-haspopup") || "listbox");
        const id = normalize(button.getAttribute("id") || "");
        pushSnapshot({
          kind: "control",
          rawKey: `${id || dataAutomationId || "fallback_button"}_${index += 1}`,
          tag: button.tagName.toLowerCase(),
          inputType: "",
          role,
          ariaHaspopup,
          label: normalize(button.textContent || button.getAttribute("aria-label") || ""),
          questionLabel,
          required: isRequired(fieldContainer, button, questionLabel),
          currentValue: normalize(button.textContent || "") || null,
          selector: selectorFor(button),
          id,
          inputName: "",
          dataAutomationId,
          containerKey: normalize(fieldContainer.getAttribute("data-automation-id") || fieldContainer.getAttribute("id") || questionLabel),
          containerLabel: questionLabel,
          containerText: normalize(fieldContainer.textContent || ""),
          promptText: normalize(fieldContainer.textContent || questionLabel),
          visibleContainerId: normalize(fieldContainer.getAttribute("data-automation-id") || fieldContainer.getAttribute("id") || resolvedRoot.selector),
          htmlSummary: {
            tag: button.tagName.toLowerCase(),
            role,
            ariaHaspopup,
            ariaInvalid: button.getAttribute("aria-invalid") === "true",
            hasInputAlert: Boolean(fieldContainer.querySelector("[data-automation-id='inputAlert']")),
            id,
            dataAutomationId,
            extractionRoot: resolvedRoot.selector,
            fallbackSelectOne: true
          }
        });
      }
    }

    return snapshots;
  }, {
    containerSelectors: [...APPLICATION_QUESTION_CONTAINER_SELECTORS],
    candidateSelector: APPLICATION_QUESTION_CANDIDATE_SELECTOR
  }).catch(() => [] as WorkdayControlSnapshot[]);
}

export async function collectWorkdayApplicationQuestionsExtractionDiagnostics(page: Page): Promise<WorkdayApplicationQuestionsExtractionDiagnostics> {
  return page.evaluate((containerSelectors) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const active = (() => {
      for (const selector of containerSelectors) {
        const node = document.querySelector(selector);
        if (visible(node)) return { selector, node };
      }
      const main = document.querySelector("main");
      if (visible(main)) return { selector: "main", node: main };
      return { selector: "body", node: document.body };
    })();
    const root = active.node;
    const buttons = Array.from(root.querySelectorAll<HTMLElement>("button, [role='button']")).filter((node) => visible(node));
    return {
      activeContainerSelectorUsed: active.selector,
      activeContainerTextSnippet: normalize(root.textContent || "").slice(0, 500),
      ariaHaspopupButtonCount: Array.from(root.querySelectorAll("button[aria-haspopup='listbox'], [role='button'][aria-haspopup='listbox']")).filter((node) => visible(node)).length,
      selectOneButtonCount: buttons.filter((button) => /select one/i.test(normalize(button.textContent || ""))).length,
      visibleListboxButtonCount: buttons.filter((button) => normalize(button.getAttribute("aria-haspopup") || "") === "listbox").length,
      requiredAriaLabelCount: Array.from(root.querySelectorAll("[aria-label*='Required']")).filter((node) => visible(node)).length,
      formFieldNodeCount: Array.from(root.querySelectorAll("[data-automation-id^='formField-']")).filter((node) => visible(node)).length,
      visibleRequiredSelectOneCount: buttons.filter((button) => {
        const text = normalize(button.textContent || "");
        const ariaLabel = normalize(button.getAttribute("aria-label") || "");
        return /select one/i.test(text) && /required/i.test(ariaLabel);
      }).length,
      topVisibleButtons: buttons.slice(0, 20).map((button) => ({
        text: normalize(button.textContent || ""),
        ariaLabel: normalize(button.getAttribute("aria-label") || ""),
        dataAutomationId: normalize(button.getAttribute("data-automation-id") || "")
      }))
    };
  }, [...APPLICATION_QUESTION_CONTAINER_SELECTORS]).catch(() => ({
    activeContainerSelectorUsed: "body",
    activeContainerTextSnippet: "",
    ariaHaspopupButtonCount: 0,
    selectOneButtonCount: 0,
    visibleListboxButtonCount: 0,
    requiredAriaLabelCount: 0,
    formFieldNodeCount: 0,
    visibleRequiredSelectOneCount: 0,
    topVisibleButtons: []
  }));
}

export async function extractWorkdayStepWidgets(page: Page, step: WorkdayStep): Promise<WorkdayWidgetSchema[]> {
  if (step === "application_questions") {
    const controls = await extractApplicationQuestionControls(page);
    const widgets = buildWorkdayWidgetsFromControls(controls, step);
    const hydrated: WorkdayWidgetSchema[] = [];
    for (const widget of widgets) {
      hydrated.push(await hydrateWorkdayWidgetOptions(page, widget));
    }
    return hydrated;
  }

  const activeContainerSelector = await resolveActiveWorkdayContainerSelector(page, step);
  const controls = await page.evaluate(({ currentStep, containerSelector }) => {
    const normalize = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
    const cssEscape = (value: string): string => {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
      return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    };
    const visible = (node: Element | null): node is HTMLElement => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const labelFromName = (name: string): string => {
      const known: Record<string, string> = {
        "candidateIsPreviousWorker": "Previously worked for this company",
        "legalName--firstName": "Legal First Name",
        "legalName--lastName": "Legal Last Name",
        "legalName--secondaryLastName": "Secondary Last Name",
        "addressLine1": "Address Line 1",
        "addressLine2": "Address Line 2",
        "city": "City",
        "postalCode": "Postal Code",
        "phoneNumber": "Phone Number",
        "extension": "Phone Extension"
      };
      if (known[name]) return known[name];
      return name
        .replace(/--/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    const selectorFor = (control: HTMLElement, preferInput = false): string => {
      const id = normalize(control.getAttribute("id") || "");
      if (id) return `[id="${id.replace(/"/g, '\\"')}"]`;
      const dataAutomationId = normalize(control.getAttribute("data-automation-id") || "");
      if (dataAutomationId) return `${control.tagName.toLowerCase()}[data-automation-id="${dataAutomationId.replace(/"/g, '\\"')}"]`;
      const name = normalize(control.getAttribute("name") || "");
      if (name) return `${preferInput ? "input" : control.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
      return "";
    };
    const fieldContainerFor = (control: HTMLElement): HTMLElement | null => {
      return control.closest(
        "fieldset, [data-automation-id^='formField-'], [data-automation-id$='Section'], [data-automation-id*='PanelSet'], section, [role='group']"
      );
    };
    const sectionRootFor = (control: HTMLElement): HTMLElement | null => {
      return control.closest(
        "[data-automation-id='workExperienceSection'], [data-automation-id='educationSection'], [data-automation-id='websiteSection'], [data-automation-id='skillsSection']"
      );
    };
    const containerLabel = (container: HTMLElement | null): string => {
      if (!container) return "";
      const optionTexts = new Set(
        Array.from(container.querySelectorAll<HTMLElement>("input[type='radio'], input[type='checkbox']"))
          .map((input) => {
            const id = normalize(input.getAttribute("id") || "");
            const forLabel = id
              ? normalize((container.querySelector(`label[for="${cssEscape(id)}"]`)?.textContent || ""))
              : "";
            const wrapLabel = normalize(input.closest("label")?.textContent || "");
            return forLabel || wrapLabel;
          })
          .filter(Boolean)
          .map((value) => value.toLowerCase())
      );
      const candidates = Array.from(
        container.querySelectorAll("legend, [data-automation-id='formLabel'], [data-automation-id*='richText'], label, h1, h2, h3, h4, h5")
      )
        .map((node) => normalize(node.textContent || ""))
        .filter(Boolean)
        .filter((value) => !optionTexts.has(value.toLowerCase()));
      if (candidates.length) return candidates[0] || "";

      const containerText = normalize(container.textContent || "");
      if (!containerText) return "";
      const optionList = Array.from(optionTexts);
      let prefix = containerText;
      let cutIndex = containerText.length;
      for (const option of optionList) {
        const idx = containerText.toLowerCase().indexOf(option);
        if (idx > 0 && idx < cutIndex) cutIndex = idx;
      }
      if (cutIndex < containerText.length) {
        prefix = normalize(containerText.slice(0, cutIndex));
      }
      return prefix;
    };
    const isGenericDateLabel = (value: string): boolean => /^(mm|dd|yyyy|month|day|year|mm\/yyyy|mm\/dd\/yyyy)$/i.test(normalize(value));
    const inheritedDateQuestionLabel = (control: HTMLElement, fieldContainer: HTMLElement | null): string => {
      const roots = [
        fieldContainer,
        fieldContainer?.parentElement,
        fieldContainer?.closest("[role='group']"),
        fieldContainer?.closest("fieldset"),
        control.closest("section"),
        control.parentElement?.closest("[data-automation-id^='formField-']"),
        control.parentElement?.closest("[role='group']")
      ].filter((root): root is HTMLElement => root instanceof HTMLElement);
      for (const root of roots) {
        const candidates = Array.from(root.querySelectorAll("legend, [data-automation-id='formLabel'], [data-automation-id*='richText'], label, h1, h2, h3, h4, h5"))
          .map((node) => normalize(node.textContent || ""))
          .filter(Boolean)
          .map((text) => normalize(
            text
              .replace(/\b(?:mm\/dd\/yyyy|mm\/yyyy)\b/gi, " ")
              .replace(/\b(?:mm|dd|yyyy|month|day|year)\b/gi, " ")
          ))
          .filter((text) => text && !isGenericDateLabel(text));
        if (candidates.length) return candidates[0] || "";
      }
      return "";
    };
    const isNavigationControl = (tag: string, dataAutomationId: string, label: string, ariaLabel: string, role: string): boolean => {
      const key = `${dataAutomationId} ${label} ${ariaLabel} ${role}`.toLowerCase();
      if (!key) return false;
      if (/backtojobposting|pagefooternextbutton|bottom-navigation-next-button|signin|createaccount|applymanually|adventurebutton/.test(key)) return true;
      if (tag !== "input" && /(back to job|apply manually|start application|sign in|create account|save and continue|^continue$|^next$|^submit$)/.test(key)) return true;
      return false;
    };

    const activeContainer =
      document.querySelector(containerSelector) ||
      document.querySelector("main") ||
      document.querySelector("form") ||
      document.body;

    const snapshots: WorkdayControlSnapshot[] = [];
    let index = 0;

    const panelConfigs = [
      { sectionSelector: "[data-automation-id='workExperienceSection']", fieldSuffix: "--jobTitle" },
      { sectionSelector: "[data-automation-id='educationSection']", fieldSuffix: "--school" }
    ];
    for (const panelConfig of panelConfigs) {
      const section = activeContainer.querySelector(panelConfig.sectionSelector);
      if (!visible(section)) continue;
      const addButton = section.querySelector<HTMLElement>("button[data-automation-id='add-button'], button[data-automation-id='Add'], button[data-automation-id*='add']");
      const heading = normalize(section.querySelector("h1, h2, h3, h4, legend")?.textContent || section.textContent || "");
      const dataAutomationId = normalize(section.getAttribute("data-automation-id") || "");
      const prefixes = Array.from(
        new Set(
          Array.from(section.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(`input[id$="${panelConfig.fieldSuffix}"], textarea[id$="${panelConfig.fieldSuffix}"]`))
            .map((node) => normalize(node.getAttribute("id") || ""))
            .filter(Boolean)
            .map((id) => id.slice(0, Math.max(0, id.length - panelConfig.fieldSuffix.length)))
            .filter(Boolean)
        )
      );
      snapshots.push({
        kind: "panel",
        rawKey: `${dataAutomationId || panelConfig.sectionSelector}_panel`,
        tag: "section",
        inputType: "",
        role: "",
        ariaHaspopup: "",
        label: heading || dataAutomationId || panelConfig.sectionSelector,
        questionLabel: heading || dataAutomationId || panelConfig.sectionSelector,
        required: dataAutomationId === "workExperienceSection",
        currentValue: prefixes.length ? [String(prefixes.length)] : null,
        selector: panelConfig.sectionSelector,
        id: "",
        inputName: "",
        dataAutomationId,
        containerKey: dataAutomationId || panelConfig.sectionSelector,
        containerLabel: heading,
        containerText: normalize(section.textContent || ""),
        promptText: normalize(section.textContent || ""),
        visibleContainerId: dataAutomationId || currentStep,
        addButtonSelector: addButton ? selectorFor(addButton) : undefined,
        rowPrefixFieldSuffix: panelConfig.fieldSuffix,
        panelItemPrefixes: prefixes,
        htmlSummary: {
          panelKind: dataAutomationId
        }
      });
    }

    const controls = Array.from(activeContainer.querySelectorAll("input, textarea, button, select, [role='combobox']")).filter((control) => visible(control));
    for (const control of controls) {
      if (!(control instanceof HTMLElement)) continue;
      const tag = control.tagName.toLowerCase();
      const input = control as HTMLInputElement;
      const inputType = normalize(input.type || "").toLowerCase();
      if (["hidden", "submit", "reset"].includes(inputType)) continue;

      const dataAutomationId = normalize(control.getAttribute("data-automation-id") || "");
      const role = normalize(control.getAttribute("role") || "");
      const ariaHaspopup = normalize(control.getAttribute("aria-haspopup") || "");
      const inputName = normalize(control.getAttribute("name") || "");
      const id = normalize(control.getAttribute("id") || "");
      const aria = normalize(control.getAttribute("aria-label") || "");

      const ownLabel = id
        ? normalize((document.querySelector(`label[for="${cssEscape(id)}"]`)?.textContent || ""))
        : "";
      const wrapLabel = normalize(control.closest("label")?.textContent || "");
      const fieldContainer = fieldContainerFor(control);
      const sectionRoot = sectionRootFor(control);
      const sectionKind = normalize(sectionRoot?.getAttribute("data-automation-id") || "");
      const fieldContainerLabel = containerLabel(fieldContainer);
      const questionLabel = fieldContainerLabel || ownLabel || wrapLabel || aria || (inputName ? labelFromName(inputName) : "") || dataAutomationId || `field_${index}`;
      const controlLabel = ownLabel || wrapLabel || aria || normalize(input.value || "") || questionLabel;
      if (isNavigationControl(tag, dataAutomationId, questionLabel, aria, role)) continue;

      const required =
        control.hasAttribute("required") ||
        control.getAttribute("aria-required") === "true" ||
        Boolean(fieldContainer?.querySelector(".requiredAsterisk")) ||
        /\*/.test(questionLabel);

      let currentValue: string | string[] | null = null;
      if (inputType === "radio" || inputType === "checkbox") {
        currentValue = input.checked ? "checked" : null;
      } else if (tag === "textarea" || tag === "input") {
        currentValue = normalize((control as HTMLInputElement | HTMLTextAreaElement).value || "") || null;
      } else if (tag === "select") {
        const selected = (control as HTMLSelectElement).selectedOptions?.[0];
        currentValue = normalize(selected?.textContent || (control as HTMLSelectElement).value || "") || null;
      } else if (tag === "button") {
        currentValue = normalize(control.textContent || "") || null;
      }

      const isDateSection = /-dateSection(?:Month|Day|Year)-input$/i.test(id);
      const dateGroupKey = isDateSection ? id.replace(/-dateSection(?:Month|Day|Year)-input$/i, "") : "";
      const sectionCount = dateGroupKey
        ? activeContainer.querySelectorAll(`[id^="${dateGroupKey.replace(/"/g, '\\"')}"][id*="-dateSection"][id$="-input"]`).length
        : 0;
      const inheritedQuestionLabel = isDateSection && isGenericDateLabel(questionLabel)
        ? inheritedDateQuestionLabel(control, fieldContainer)
        : "";
      const finalQuestionLabel = inheritedQuestionLabel || questionLabel;
      const finalControlLabel = ownLabel || wrapLabel || aria || normalize(input.value || "") || finalQuestionLabel;
      const promptCurrentValue = (): string | null => {
        const container = control.closest("[data-automation-id='multiSelectContainer'], [data-automation-id='multiselectInputContainer'], [data-automation-id^='formField-'], [data-automation-id*='formField']") as HTMLElement | null;
        const selectedTexts = Array.from((container || fieldContainer || activeContainer).querySelectorAll<HTMLElement>("[data-automation-id='selectedItem'], [data-automation-id='selectedItemList'] [data-automation-id='promptOption'], [data-automation-id='selectedItemList'] [role='option']"))
          .map((node) => normalize(node.textContent || node.getAttribute("aria-label") || ""))
          .filter(Boolean);
        if (selectedTexts.length) return Array.from(new Set(selectedTexts)).join(" / ");
        const promptInstruction = normalize((container || fieldContainer || activeContainer).querySelector<HTMLElement>("[data-automation-id='promptAriaInstruction']")?.textContent || "");
        const promptSelection = normalize((container || fieldContainer || activeContainer).querySelector<HTMLElement>("[data-automation-id='promptSelectionLabel']")?.textContent || "");
        const promptValue = promptSelection || promptInstruction.replace(/^\d+\s+items?\s+selected,\s*/i, "").trim();
        return promptValue || null;
      };

      snapshots.push({
        kind: "control",
        rawKey: `${id || dataAutomationId || inputName || tag}_${index}`,
        tag,
        inputType,
        role,
        ariaHaspopup,
        label: finalControlLabel,
        questionLabel: finalQuestionLabel,
        required,
        currentValue: (tag === "textarea" || tag === "input") ? (promptCurrentValue() || currentValue) : currentValue,
        selector: selectorFor(control, tag === "input"),
        id,
        inputName,
        dataAutomationId,
        containerKey: normalize(fieldContainer?.getAttribute("data-automation-id") || fieldContainer?.getAttribute("id") || finalQuestionLabel),
        containerLabel: fieldContainerLabel,
        containerText: normalize(fieldContainer?.textContent || ""),
        optionLabel: inputType === "radio" || inputType === "checkbox" ? controlLabel : undefined,
        optionSelector: inputType === "radio" || inputType === "checkbox" ? selectorFor(control, true) : undefined,
        promptText: normalize(fieldContainer?.textContent || finalQuestionLabel || finalControlLabel),
        visibleContainerId: normalize(fieldContainer?.getAttribute("data-automation-id") || fieldContainer?.getAttribute("id") || currentStep),
        dateGroupKey: dateGroupKey || undefined,
        sectionCount: sectionCount || undefined,
        htmlSummary: {
          tag,
          inputType,
          role,
          ariaHaspopup,
          id,
          valueText: normalize(input.value || ""),
          dataAutomationId,
          sectionKind
        }
      });

      index += 1;
    }

    return snapshots;
  }, { currentStep: step, containerSelector: activeContainerSelector }).catch(() => [] as WorkdayControlSnapshot[]);

  const widgets = buildWorkdayWidgetsFromControls(controls, step);
  const hydrated: WorkdayWidgetSchema[] = [];
  for (const widget of widgets) {
    // Every step gets native <select> options read, because they cost one DOM
    // query. Skipping them left "How Did You Hear About Us?" -- a standard
    // Contact Information dropdown -- with an empty option list on every run,
    // so nothing could be chosen and the step failed.
    hydrated.push(await hydrateWorkdayWidgetOptions(page, widget, step === "my_experience" ? "full" : "native"));
  }
  return hydrated;
}

export async function extractWorkdayStepSchema(page: Page, step: WorkdayStep): Promise<WorkdayFieldSchema[]> {
  const widgets = await extractWorkdayStepWidgets(page, step);
  return widgets.map(makeLegacyField);
}
