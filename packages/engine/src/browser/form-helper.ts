import type { Frame, Locator, Page } from "playwright-core";
import type { AnswerValue, ApplicationQuestion, QuestionType, ResolvedAnswer } from "../core/types.js";

export interface DetectedField extends ApplicationQuestion {
  selector: string;
  tag: string;
  selectorCandidates?: string[];
}

function mapInputType(tag: string, inputType: string | null, multiple: boolean): QuestionType {
  if (tag === "textarea") return "textarea";
  if (tag === "select") return multiple ? "multi_select" : "single_select";
  if (inputType === "checkbox") return "boolean";
  if (inputType === "radio") return "single_select";
  if (inputType === "file") return "file";
  if (tag === "input") return "text";
  return "unknown";
}

function safeCssAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function normalizeOption(value: string): string {
  return value.trim().toLowerCase();
}

function isLocationLikeLabel(label: string): boolean {
  const normalized = normalizeOption(label);
  if (!normalized) return false;
  if (/export control|citizenship|nationality|permanent residence/.test(normalized)) return false;
  return /location|currently based|based in|where are you|current city|\bcity\b/.test(normalized);
}

function toBooleanChoice(value: AnswerValue): boolean {
  const raw = String(Array.isArray(value) ? value[0] ?? "" : value).toLowerCase();
  return ["1", "true", "yes", "y"].includes(raw);
}

function answerToStringList(value: AnswerValue): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value).trim();
  return text ? [text] : [];
}

function coerceBooleanLikeChoice(value: string): string {
  const normalized = normalizeOption(value);
  if (["true", "1", "y"].includes(normalized)) return "yes";
  if (["false", "0", "n"].includes(normalized)) return "no";
  return normalized;
}

function pickOption(target: string, options: string[]): string | undefined {
  if (!target.trim()) return undefined;
  const wanted = normalizeOption(target);
  const exact = options.find((option) => normalizeOption(option) === wanted);
  if (exact) return exact;

  const contains = options.find((option) => normalizeOption(option).includes(wanted));
  if (contains) return contains;

  const reverseContains = options.find((option) => wanted.includes(normalizeOption(option)));
  if (reverseContains) return reverseContains;

  return undefined;
}

type FillScope = Page | Frame | Locator;

async function waitForScopeTimeout(scope: FillScope, ms: number): Promise<void> {
  if ("waitForTimeout" in scope) {
    await scope.waitForTimeout(ms).catch(() => undefined);
    return;
  }
  await scope.page().waitForTimeout(ms).catch(() => undefined);
}

function findLabelLocatorByFor(scope: FillScope, id: string): Locator {
  return scope.locator(`label[for="${safeCssAttribute(id)}"]`).first();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSelectorAttribute(selector: string, attribute: "id" | "name"): string | undefined {
  const exactMatch = selector.match(new RegExp(`\\[${attribute}="([^"]+)"\\]`));
  if (exactMatch?.[1]) return exactMatch[1];
  const fuzzyMatch = selector.match(new RegExp(`${attribute}\\*="([^"]+)"`));
  return fuzzyMatch?.[1];
}

async function locateByCandidates(scope: FillScope, field: DetectedField): Promise<Locator> {
  const firstVisible = async (locator: Locator): Promise<Locator | null> => {
    const total = await locator.count().catch(() => 0);
    for (let i = 0; i < total; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
    return null;
  };

  const selectors = [field.selector, ...(field.selectorCandidates ?? [])].filter(Boolean);
  for (const selector of selectors) {
    const locator = scope.locator(selector);
    const visible = await firstVisible(locator);
    if (visible) return visible;
    if (await locator.count().catch(() => 0)) {
      return locator.first();
    }
  }

  const label = field.label.replace(/\*/g, "").trim();
  if (label) {
    const labelRegex = new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i");
    const byLabel = scope.getByLabel(labelRegex);
    const visibleByLabel = await firstVisible(byLabel);
    if (visibleByLabel) {
      return visibleByLabel;
    }
    if (await byLabel.count().catch(() => 0)) {
      return byLabel.first();
    }

    const wrapLabelControl = scope
      .locator(
        `label:has-text("${safeCssAttribute(label)}") input, label:has-text("${safeCssAttribute(label)}") textarea, label:has-text("${safeCssAttribute(label)}") select`
      );
    const visibleWrap = await firstVisible(wrapLabelControl);
    if (visibleWrap) {
      return visibleWrap;
    }
    if (await wrapLabelControl.count().catch(() => 0)) {
      return wrapLabelControl.first();
    }

    const nearbyLabelControl = scope
      .locator(`label:has-text("${safeCssAttribute(label)}")`)
      .locator("xpath=following::input[1] | following::textarea[1] | following::select[1]");
    const visibleNearby = await firstVisible(nearbyLabelControl);
    if (visibleNearby) {
      return visibleNearby;
    }
    if (await nearbyLabelControl.count().catch(() => 0)) {
      return nearbyLabelControl.first();
    }

    const byAriaLabel = scope.locator(`[aria-label="${safeCssAttribute(label)}"]`);
    const visibleByAria = await firstVisible(byAriaLabel);
    if (visibleByAria) {
      return visibleByAria;
    }
    if (await byAriaLabel.count().catch(() => 0)) {
      return byAriaLabel.first();
    }
  }

  const idHint = selectors.map((selector) => extractSelectorAttribute(selector, "id")).find(Boolean);
  if (idHint) {
    const byIdPartial = scope.locator(`[id*="${safeCssAttribute(idHint)}"]`);
    const visibleByIdPartial = await firstVisible(byIdPartial);
    if (visibleByIdPartial) {
      return visibleByIdPartial;
    }
    if (await byIdPartial.count().catch(() => 0)) {
      return byIdPartial.first();
    }
  }

  const nameHint = selectors.map((selector) => extractSelectorAttribute(selector, "name")).find(Boolean);
  if (nameHint) {
    const byNamePartial = scope.locator(`[name*="${safeCssAttribute(nameHint)}"]`);
    const visibleByNamePartial = await firstVisible(byNamePartial);
    if (visibleByNamePartial) {
      return visibleByNamePartial;
    }
    if (await byNamePartial.count().catch(() => 0)) {
      return byNamePartial.first();
    }
  }

  return scope.locator(field.selector).first();
}

async function getLabelText(scope: FillScope, control: Locator, id: string, fallback: string): Promise<string> {
  const ashbyQuestionTitle = normalizeText(
    (await control
      .locator(
        "xpath=ancestor::*[@data-field-path][1]//*[contains(@class,'ashby-application-form-question-title')][1]"
      )
      .first()
      .textContent()
      .catch(() => "")) ?? ""
  );
  if (ashbyQuestionTitle) return ashbyQuestionTitle;

  if (id) {
    const forLabel = normalizeText((await findLabelLocatorByFor(scope, id).textContent().catch(() => "")) ?? "");
    if (forLabel) return forLabel;
  }

  const ancestorLabel = normalizeText((await control.locator("xpath=ancestor::label[1]").first().textContent().catch(() => "")) ?? "");
  if (ancestorLabel) return ancestorLabel;

  const ariaLabel = normalizeText((await control.getAttribute("aria-label")) ?? "");
  if (ariaLabel) return ariaLabel;

  const labelledBy = normalizeText((await control.getAttribute("aria-labelledby")) ?? "");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const token of parts) {
      const fromId = normalizeText((await scope.locator(`#${safeCssAttribute(token)}`).first().textContent().catch(() => "")) ?? "");
      if (fromId) return fromId;
    }
  }

  return normalizeText(fallback);
}

function buildSelectorCandidates(tag: string, id: string, name: string, index: number): string[] {
  const candidates: string[] = [];

  if (id) {
    candidates.push(`${tag}[id="${safeCssAttribute(id)}"]`);
    candidates.push(`#${safeCssAttribute(id)}`);
  }

  if (name) {
    candidates.push(`${tag}[name="${safeCssAttribute(name)}"]`);
    candidates.push(`${tag}[name*="${safeCssAttribute(name)}"]`);
  }

  candidates.push(`form ${tag} >> nth=${index}`);
  candidates.push(`${tag} >> nth=${index}`);
  return dedupeStrings(candidates);
}

async function controlIsVisible(control: Locator): Promise<boolean> {
  return control.isVisible().catch(() => false);
}

export async function extractVisibleFields(scope: FillScope): Promise<DetectedField[]> {
  const buildGroups = (fallbackToGlobal: boolean) =>
    [
      { tag: "input", locator: scope.locator(fallbackToGlobal ? "input" : "form input") },
      { tag: "textarea", locator: scope.locator(fallbackToGlobal ? "textarea" : "form textarea") },
      { tag: "select", locator: scope.locator(fallbackToGlobal ? "select" : "form select") }
    ] as const;

  const fields: DetectedField[] = [];
  const groupedByName = new Map<string, number>();
  let index = 0;

  const scanGroups = async (groups: ReturnType<typeof buildGroups>) => {
    for (const group of groups) {
      const count = await group.locator.count();
      for (let i = 0; i < count; i += 1) {
        const control = group.locator.nth(i);
        if (!(await controlIsVisible(control))) continue;

        const inputType = ((await control.getAttribute("type")) ?? "").toLowerCase();
        if (inputType === "hidden") continue;
        if (["submit", "button", "reset", "image"].includes(inputType)) continue;

        const id = (await control.getAttribute("id")) ?? "";
        const name = (await control.getAttribute("name")) ?? "";
        const placeholder = (await control.getAttribute("placeholder")) ?? "";
        const role = ((await control.getAttribute("role")) ?? "").toLowerCase();
        const ariaHasPopup = ((await control.getAttribute("aria-haspopup")) ?? "").toLowerCase();
        const required =
          (await control.getAttribute("required")) !== null ||
          (await control.getAttribute("aria-required")) === "true" ||
          (await control.getAttribute("data-required")) === "true";

        const selectorCandidates = buildSelectorCandidates(group.tag, id, name, i);
        const selector = selectorCandidates[0] ?? `form ${group.tag} >> nth=${i}`;
        const label = await getLabelText(scope, control, id, placeholder || name || id || `${group.tag}_${i}`);

        const dataListId = ((await control.getAttribute("list")) ?? "").trim();
        const datalistOptions = dataListId
          ? await scope
              .locator(`#${safeCssAttribute(dataListId)} option`)
              .allTextContents()
              .then((items) => items.map((item) => normalizeText(item)))
              .catch(() => [] as string[])
          : [];

        const selectOptions =
          group.tag === "select"
            ? await control
                .locator("option")
                .allTextContents()
                .then((items) => items.map((item) => normalizeText(item)).filter(Boolean))
                .catch(() => [] as string[])
            : [];

        const options = dedupeStrings([...selectOptions, ...datalistOptions]);
        const isMultiple = group.tag === "select" ? (await control.getAttribute("multiple")) !== null : false;

        if (group.tag === "input" && (inputType === "radio" || inputType === "checkbox") && name) {
          const groupedKey = `${inputType}:${name}`;
          const existingIndex = groupedByName.get(groupedKey);
          const labelByFor =
            id && id.trim()
              ? normalizeText((await scope.locator(`label[for="${safeCssAttribute(id)}"]`).first().textContent().catch(() => "")) ?? "")
              : "";
          const ancestorLabel = normalizeText((await control.locator("xpath=ancestor::label[1]").textContent().catch(() => "")) ?? "");
          const ariaLabel = normalizeText((await control.getAttribute("aria-label").catch(() => "")) ?? "");
          const choiceLabel = labelByFor || ancestorLabel || ariaLabel || label;
          const questionLabel =
            normalizeText(
              (await control
                .locator(
                  "xpath=ancestor::*[@data-field-path][1]//*[contains(@class,'ashby-application-form-question-title')][1]"
                )
                .first()
                .textContent()
                .catch(() => "")) ?? ""
            ) ||
            label ||
            name ||
            id ||
            groupedKey;

          if (existingIndex !== undefined) {
            const existing = fields[existingIndex];
            if (existing) {
              const mergedOptions = dedupeStrings([...(existing.options ?? []), choiceLabel]);
              existing.options = mergedOptions.length ? mergedOptions : existing.options;
              existing.required = existing.required || required;
              existing.platformMeta = {
                ...(existing.platformMeta ?? {}),
                optionCount: mergedOptions.length,
                ariaHasPopup
              };
            }
            continue;
          }

          const optionCount = await scope
            .locator(`input[type="${inputType}"][name="${safeCssAttribute(name)}"]`)
            .count()
            .catch(() => 1);
          const isMultiCheckbox = inputType === "checkbox" && optionCount > 1;

          const field: DetectedField = {
            id: `field_${index}_${name || id || group.tag}`,
            label: questionLabel.replace(/\*/g, "").trim(),
            required,
            options: dedupeStrings([choiceLabel]),
            type: inputType === "radio" ? "single_select" : isMultiCheckbox ? "multi_select" : "boolean",
            placeholder,
            selector,
            selectorCandidates,
            tag: group.tag,
            platformMeta: {
              selector,
              selectorCandidates,
              tag: group.tag,
              inputKind: inputType,
              inputType,
              groupName: name,
              requiredVisible: required,
              role,
              ariaHasPopup,
              isMultiCheckbox,
              optionCount
            }
          };

          groupedByName.set(groupedKey, fields.length);
          fields.push(field);
          index += 1;
          continue;
        }

        const mappedType = mapInputType(group.tag, inputType, isMultiple);
        const inferredType: QuestionType =
          role === "combobox" || inputType === "search" || Boolean(dataListId)
            ? "single_select"
            : mappedType;

        fields.push({
          id: `field_${index}_${name || id || group.tag}`,
          label: (label || name || id || `field_${index}`).replace(/\*/g, "").trim(),
          required,
          options: options.length ? options : undefined,
          type: inferredType,
          placeholder,
          selector,
          selectorCandidates,
          tag: group.tag,
          platformMeta: {
            selector,
            selectorCandidates,
            tag: group.tag,
            inputKind: inferredType,
            inputType,
            groupName: name || undefined,
            requiredVisible: required,
            role,
            ariaHasPopup,
            hasDatalist: Boolean(dataListId),
            isMultiple,
            options
          }
        });
        index += 1;
      }
    }
  };

  await scanGroups(buildGroups(false));
  if (fields.length === 0) {
    await scanGroups(buildGroups(true));
  }

  const knownFieldPaths = new Set(
    fields
      .map((field) => String(field.platformMeta?.fieldPath ?? "").trim())
      .filter(Boolean)
      .map((item) => item.toLowerCase())
  );
  const comboLocator = scope.locator("form [role='combobox'], [role='combobox']");
  const comboCount = await comboLocator.count().catch(() => 0);
  for (let i = 0; i < comboCount; i += 1) {
    const combo = comboLocator.nth(i);
    if (!(await controlIsVisible(combo))) continue;

    const fieldPath = normalizeText(
      (await combo
        .locator("xpath=ancestor::*[@data-field-path][1]")
        .first()
        .getAttribute("data-field-path")
        .catch(() => "")) ?? ""
    );
    if (fieldPath && knownFieldPaths.has(fieldPath.toLowerCase())) continue;

    const label = await getLabelText(
      scope,
      combo,
      "",
      (await combo.getAttribute("aria-label").catch(() => "")) ?? `combobox_${index}`
    );
    const selector = fieldPath
      ? `[data-field-path="${safeCssAttribute(fieldPath)}"] [role="combobox"]`
      : `[role="combobox"] >> nth=${i}`;
    const selectorCandidates = dedupeStrings([
      selector,
      fieldPath ? `[data-field-path="${safeCssAttribute(fieldPath)}"] [aria-haspopup="listbox"]` : "",
      `[role="combobox"] >> nth=${i}`
    ]).filter(Boolean);
    const requiredFromLabel = /\*\s*$/.test((label || "").trim());
    const required =
      requiredFromLabel ||
      (await combo.getAttribute("aria-required").catch(() => "")) === "true" ||
      (await combo.getAttribute("required").catch(() => null)) !== null;
    const id = fieldPath ? `field_${index}_${fieldPath}` : `field_${index}_combobox`;

    fields.push({
      id,
      label: (label || `field_${index}`).replace(/\*/g, "").trim(),
      required,
      options: undefined,
      type: "single_select",
      placeholder: "",
      selector,
      selectorCandidates,
      tag: "div",
      platformMeta: {
        selector,
        selectorCandidates,
        tag: "div",
        inputKind: "single_select",
        inputType: "combobox",
        fieldPath: fieldPath || undefined,
        requiredVisible: required,
        role: "combobox",
        ariaHasPopup: "listbox",
        options: []
      }
    });
    if (fieldPath) knownFieldPaths.add(fieldPath.toLowerCase());
    index += 1;
  }

  return fields.filter((field) => Boolean(field.label || field.selector));
}

async function fillSingleSelect(locator: Locator, field: DetectedField, value: string): Promise<boolean> {
  const candidates = dedupeStrings([value, pickOption(value, field.options ?? []) ?? ""]).filter(Boolean);
  const selectedValue = candidates[0] ?? value;

  const tag = field.tag.toLowerCase();
  if (tag === "select") {
    for (const candidate of candidates) {
      const byLabel = await locator.selectOption({ label: candidate }).catch(() => [] as string[]);
      if (byLabel.length > 0) return true;
      const byValue = await locator.selectOption({ value: candidate }).catch(() => [] as string[]);
      if (byValue.length > 0) return true;
    }
    return false;
  }

  await locator.click({ timeout: 2000 }).catch(() => undefined);
  await locator.fill(selectedValue).catch(() => undefined);

  const role = ((await locator.getAttribute("role").catch(() => "")) ?? "").toLowerCase();
  const hasListbox = ((await locator.getAttribute("aria-haspopup").catch(() => "")) ?? "").toLowerCase() === "listbox";
  if (role === "combobox" || hasListbox) {
    const listboxId = ((await locator.getAttribute("aria-controls").catch(() => "")) ?? "").trim();
    const isLocationField = isLocationLikeLabel(field.label);
    if (isLocationField) {
      await locator.click({ timeout: 2000 }).catch(() => undefined);
      await locator.fill("").catch(() => undefined);
      await locator.type(selectedValue, { delay: 25 }).catch(() => undefined);
      // Location autocompletes can be async; wait briefly for options to populate.
      const startedAt = Date.now();
      let optionsVisible = false;
      while (Date.now() - startedAt < 2500) {
        const scopedCount = listboxId
          ? await locator.page().locator(`#${safeCssAttribute(listboxId)} [role='option']`).count().catch(() => 0)
          : 0;
        const globalCount = await locator.page().getByRole("option").count().catch(() => 0);
        if (scopedCount > 0 || globalCount > 0) {
          optionsVisible = true;
          break;
        }
        await locator.page().waitForTimeout(120).catch(() => undefined);
      }
      if (!optionsVisible) {
        await locator.page().waitForTimeout(300).catch(() => undefined);
      }
    }
    await locator.page().waitForTimeout(120).catch(() => undefined);
    if (listboxId) {
      const scopedOption = locator.page().locator(`#${safeCssAttribute(listboxId)} [role='option']`).first();
      if (await scopedOption.isVisible().catch(() => false)) {
        await scopedOption.click().catch(() => undefined);
        await locator.page().waitForTimeout(80).catch(() => undefined);
        const scopedValue = ((await locator.inputValue().catch(() => "")) ?? "").trim();
        if (scopedValue.length > 0) {
          await locator.blur().catch(() => undefined);
          return true;
        }
      }
    }
    for (const candidate of candidates) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const optionLocator = locator.page().getByRole("option", { name: new RegExp(`^\\s*${escaped}\\s*$`, "i") }).first();
      if (await optionLocator.isVisible().catch(() => false)) {
        await optionLocator.click().catch(() => undefined);
        await locator.page().waitForTimeout(80).catch(() => undefined);
        const exactValue = ((await locator.inputValue().catch(() => "")) ?? "").trim();
        if (exactValue.length > 0) {
          await locator.blur().catch(() => undefined);
          return true;
        }
      }
    }

    if (!isLocationField) {
      await locator.press("ArrowDown").catch(() => undefined);
      await locator.press("Enter").catch(() => undefined);
      const currentValue = ((await locator.inputValue().catch(() => "")) ?? "").trim();
      if (currentValue.length > 0) {
        await locator.blur().catch(() => undefined);
        return true;
      }
    } else {
      // For location fields, never commit a blind first option after typing.
      const currentValue = ((await locator.inputValue().catch(() => "")) ?? "").trim();
      if (currentValue.length > 0) {
        await locator.blur().catch(() => undefined);
        return true;
      }
      return false;
    }
  }

  const optionChoice = pickOption(selectedValue, field.options ?? []);
  if (optionChoice) {
    const optionLocator = locator.page().getByRole("option", { name: new RegExp(optionChoice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
    if (await optionLocator.isVisible().catch(() => false)) {
      await optionLocator.click().catch(() => undefined);
      await locator.blur().catch(() => undefined);
      return true;
    }
  }

  if (!isLocationLikeLabel(field.label)) {
    await locator.press("Enter").catch(() => undefined);
  }
  await locator.blur().catch(() => undefined);
  const committed = ((await locator.inputValue().catch(() => "")) ?? "").trim();
  return committed.length > 0;
}

async function fillBooleanGroup(scope: FillScope, field: DetectedField, locator: Locator, value: AnswerValue): Promise<boolean> {
  const target = toBooleanChoice(value);
  const settle = async () => {
    await locator.page().waitForTimeout(120).catch(() => undefined);
  };

  const groupName = typeof field.platformMeta?.groupName === "string" ? field.platformMeta.groupName : "";
  const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? field.platformMeta.fieldPath : "";
  const escapedFieldPath = fieldPath ? safeCssAttribute(fieldPath) : "";
  if (groupName) {
    const optionText = target ? "Yes" : "No";
    const scopedGroup = escapedFieldPath
      ? scope.locator(`[data-field-path="${escapedFieldPath}"] input[type=\"checkbox\"][name=\"${safeCssAttribute(groupName)}\"]`)
      : scope.locator(`input[type=\"checkbox\"][name=\"${safeCssAttribute(groupName)}\"]`);
    const group = scopedGroup.first();
    const container = group.locator("xpath=ancestor::*[@data-field-path][1] | ancestor::*[contains(@class,'_fieldEntry_')][1]").first();
    const containerButton = container.getByRole("button", { name: new RegExp(`^${optionText}$`, "i") }).first();
    if (await containerButton.isVisible().catch(() => false)) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await containerButton.click().catch(() => undefined);
        await settle();
        const selectedButton = await container
          .locator("button[aria-pressed='true'], button[aria-checked='true'], button[data-state='checked'], button[class*='selected'], button[class*='active']")
          .count()
          .catch(() => 0);
        const checkedNow = await group.isChecked().catch(() => false);
        if (selectedButton > 0 || checkedNow === target) return true;
      }
      return true;
    }

    const checked = await group.isChecked().catch(() => false);
    if (checked !== target) {
      await group.click({ force: true }).catch(() => undefined);
      await settle();
    }
    return true;
  }

  const checked = await locator.isChecked().catch(() => false);
  if (checked !== target) {
    await locator.click({ force: true }).catch(() => undefined);
    await settle();
  }
  return true;
}

async function fillSingleChoiceGroup(scope: FillScope, field: DetectedField, value: string): Promise<boolean> {
  const primaryGroupName = typeof field.platformMeta?.groupName === "string" ? field.platformMeta.groupName : "";
  const extraGroupNames = Array.isArray(field.platformMeta?.groupNames)
    ? (field.platformMeta?.groupNames as unknown[]).map((item) => String(item).trim()).filter(Boolean)
    : [];
  const groupNames = dedupeStrings([primaryGroupName, ...extraGroupNames]).filter(Boolean);
  const fieldPath = typeof field.platformMeta?.fieldPath === "string" ? field.platformMeta.fieldPath : "";
  const escapedFieldPath = fieldPath ? safeCssAttribute(fieldPath) : "";

  const option = pickOption(value, field.options ?? []) ?? value;
  const normalizedChoice = coerceBooleanLikeChoice(option);
  const aliases = normalizedChoice === "yes"
    ? ["yes", "true"]
    : normalizedChoice === "no"
      ? ["no", "false"]
      : [normalizedChoice];
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scopedRoot = escapedFieldPath ? scope.locator(`[data-field-path="${escapedFieldPath}"]`).first() : scope;
  const settle = async () => {
    await waitForScopeTimeout(scope, 120);
  };
  const groupSelector = (type: "radio" | "checkbox", checked: boolean = false): string =>
    groupNames.length > 0
      ? groupNames
          .map(
            (groupName) =>
              `input[type="${type}"][name="${safeCssAttribute(groupName)}"]${checked ? ":checked" : ""}`
          )
          .join(", ")
      : `input[type="${type}"]${checked ? ":checked" : ""}`;
  const hasSelection = async (): Promise<boolean> => {
    const checkedRadio = await scopedRoot.locator(groupSelector("radio", true)).count().catch(() => 0);
    const checkedCheckbox = await scopedRoot.locator(groupSelector("checkbox", true)).count().catch(() => 0);
    const selectedButtons = await scopedRoot
      .locator(
        "button[aria-pressed='true'], button[aria-checked='true'], button[aria-selected='true'], button[data-state='checked'], button[class*='selected'], button[class*='active'], button[class*='checked'], [role='radio'][aria-checked='true'], [role='option'][aria-selected='true']"
      )
      .count()
      .catch(() => 0);
    return checkedRadio > 0 || checkedCheckbox > 0 || selectedButtons > 0;
  };

  for (const alias of aliases) {
    const buttonByText = scopedRoot.getByRole("button", { name: new RegExp(`^\\s*${alias}\\s*$`, "i") }).first();
    if (await buttonByText.isVisible().catch(() => false)) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await buttonByText.click().catch(() => undefined);
        await settle();
        if (await hasSelection()) return true;
      }
    }
  }

  for (const groupName of groupNames) {
    const labelCandidate = scopedRoot
      .locator(`label:has(input[name=\"${safeCssAttribute(groupName)}\"])`)
      .filter({ hasText: new RegExp(escaped, "i") })
      .first();
    if (await labelCandidate.isVisible().catch(() => false)) {
      await labelCandidate.click().catch(() => undefined);
      await settle();
      if (await hasSelection()) return true;
    }
  }

  const labelsByFor = scopedRoot.locator("label[for]").filter({ hasText: new RegExp(escaped, "i") });
  const labelCount = await labelsByFor.count().catch(() => 0);
  for (let i = 0; i < labelCount; i += 1) {
    const label = labelsByFor.nth(i);
    const forId = ((await label.getAttribute("for").catch(() => "")) ?? "").trim();
    if (!forId) continue;
    for (const groupName of groupNames) {
      const targetRadio = scopedRoot
        .locator(`input[type=\"radio\"][id=\"${safeCssAttribute(forId)}\"][name=\"${safeCssAttribute(groupName)}\"]`)
        .first();
      if (await targetRadio.count().catch(() => 0)) {
        await label.click().catch(() => undefined);
        await settle();
        const checked = await targetRadio.isChecked().catch(() => false);
        if (!checked) {
          await targetRadio.check({ force: true }).catch(() => undefined);
          await settle();
        }
        if (await hasSelection()) return true;
      }
    }
  }

  for (const groupName of groupNames) {
    const radioByValue = scopedRoot
      .locator(`input[type=\"radio\"][name=\"${safeCssAttribute(groupName)}\"][value=\"${safeCssAttribute(option)}\"]`)
      .first();
    if (await radioByValue.count().catch(() => 0)) {
      await radioByValue.check({ force: true }).catch(() => undefined);
      await settle();
      if (await hasSelection()) return true;
    }
  }

  const groupInputs = scopedRoot.locator(
    `${groupSelector("radio", false)}, ${groupSelector("checkbox", false)}`
  );
  const total = await groupInputs.count().catch(() => 0);
  for (let i = 0; i < total; i += 1) {
    const input = groupInputs.nth(i);
    const aria = normalizeText((await input.getAttribute("aria-label").catch(() => "")) ?? "");
    const ariaNormalized = coerceBooleanLikeChoice(aria);
    const isAliasMatch = aliases.some((alias) => ariaNormalized === alias || ariaNormalized.includes(alias));
    const isOptionMatch =
      normalizeOption(aria) === normalizeOption(option) || normalizeOption(aria).includes(normalizeOption(option));
    if (isAliasMatch || isOptionMatch) {
      await input.check({ force: true }).catch(() => undefined);
      await settle();
      await input.evaluate((node) => {
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
      }).catch(() => undefined);
      await settle();
      if (await hasSelection()) return true;
    }
  }

  if (total > 0) {
    const first = groupInputs.first();
    await first.check({ force: true }).catch(() => undefined);
    await settle();
    if (await hasSelection()) return true;
  }

  return false;
}

async function fillMultiChoiceGroup(scope: FillScope, field: DetectedField, values: string[]): Promise<boolean> {
  const groupName = typeof field.platformMeta?.groupName === "string" ? field.platformMeta.groupName : "";
  if (!groupName) return false;

  const selected = values.map((value) => pickOption(value, field.options ?? []) ?? value);
  const targets = new Set(selected.map((value) => normalizeOption(value)));

  const checkboxes = scope.locator(`input[type=\"checkbox\"][name=\"${safeCssAttribute(groupName)}\"]`);
  const total = await checkboxes.count().catch(() => 0);

  let applied = false;
  for (let i = 0; i < total; i += 1) {
    const checkbox = checkboxes.nth(i);
    const valueAttr = normalizeText((await checkbox.getAttribute("value").catch(() => "")) ?? "");
    const aria = normalizeText((await checkbox.getAttribute("aria-label").catch(() => "")) ?? "");
    const label = normalizeText((await checkbox.locator("xpath=ancestor::label[1]").textContent().catch(() => "")) ?? "");
    const choiceKey = normalizeOption(label || aria || valueAttr);
    const shouldBeChecked = targets.has(choiceKey) || [...targets].some((target) => choiceKey.includes(target));
    const isChecked = await checkbox.isChecked().catch(() => false);

    if (shouldBeChecked !== isChecked) {
      await checkbox.click().catch(() => undefined);
      applied = true;
    }
  }

  return applied || total > 0;
}

export async function fillField(scope: FillScope, field: DetectedField, value: AnswerValue): Promise<boolean> {
  if (value === null || value === undefined) return false;

  const locator = await locateByCandidates(scope, field);
  const count = await locator.count().catch(() => 0);
  if (!count && !field.platformMeta?.groupName) return false;

  switch (field.type) {
    case "text":
    case "textarea": {
      const inputType = String(field.platformMeta?.inputType ?? "").toLowerCase();
      if (inputType === "number") {
        const raw = Array.isArray(value) ? String(value[0] ?? "") : String(value);
        const normalized = raw.trim().toLowerCase();
        const numericFromBoolean = normalized === "true" ? "1" : normalized === "false" ? "0" : "";
        const numericFromText = numericFromBoolean || normalized.replace(/[^0-9.-]/g, "");
        const safeNumber = numericFromText && Number.isFinite(Number(numericFromText)) ? numericFromText : "0";
        await locator.fill(safeNumber);
        await locator.blur().catch(() => undefined);
        return true;
      }
      await locator.fill(String(value));
      await locator.blur().catch(() => undefined);
      return true;
    }
    case "single_select": {
      const stringValue = String(Array.isArray(value) ? value[0] ?? "" : value);
      const inputType = String(field.platformMeta?.inputType ?? "").toLowerCase();
      if (inputType === "radio" || inputType === "custom_single_choice") {
        return fillSingleChoiceGroup(scope, field, stringValue);
      }
      return fillSingleSelect(locator, field, stringValue);
    }
    case "multi_select": {
      const values = answerToStringList(value);
      const inputType = String(field.platformMeta?.inputType ?? "").toLowerCase();
      if (inputType === "checkbox") {
        return fillMultiChoiceGroup(scope, field, values);
      }

      const options = values.map((item) => ({ label: pickOption(item, field.options ?? []) ?? item }));
      await locator.selectOption(options).catch(() => undefined);
      return true;
    }
    case "boolean": {
      return fillBooleanGroup(scope, field, locator, value);
    }
    case "file": {
      await locator.setInputFiles(String(value));
      return true;
    }
    default:
      return false;
  }
}

export function buildQuestionMap(fields: DetectedField[]): ApplicationQuestion[] {
  return fields.map((field) => ({
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    placeholder: field.placeholder,
    platformMeta: {
      selector: field.selector,
      selectorCandidates: field.selectorCandidates,
      tag: field.tag,
      ...(field.platformMeta ?? {})
    }
  }));
}

export function indexAnswersByQuestion(answers: ResolvedAnswer[]): Map<string, ResolvedAnswer> {
  const map = new Map<string, ResolvedAnswer>();
  for (const answer of answers) {
    map.set(answer.questionId, answer);
  }
  return map;
}
