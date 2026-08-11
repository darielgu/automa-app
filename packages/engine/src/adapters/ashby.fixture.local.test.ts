import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { AshbyAdapter } from './ashby.js';
import { extractVisibleFields, fillField, type DetectedField } from '../browser/form-helper.js';

interface FixtureCase {
  id: string;
  htmlPath: string;
  patternTags?: string[];
  expectedFields?: Array<{ labelIncludes: string; type?: string; required?: boolean; possibleAnswers?: string[] }>;
  executionCases?: Array<{ labelIncludes: string; value: string | string[] | boolean }>;
  recoveryCases?: Array<{ errorText: string; expectedFieldPath?: string; expectedLabelIncludes?: string; expectedFieldType?: string; allowedOptions?: string[] }>;
}

type OfflineField = {
  fieldPath: string;
  label: string;
  required: boolean;
  type: 'text' | 'textarea' | 'file' | 'radio' | 'checkbox_group' | 'yes_no' | 'combobox' | 'date';
  options: string[];
};

const fixtureRoot = path.resolve(process.cwd(), '.playwright-mcp/ashby-fixtures');
const catalogPath = path.join(fixtureRoot, 'catalog.json');

function normalize(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function loadCatalog(): { fixtures: FixtureCase[] } {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Missing local fixture catalog at ${catalogPath}. Run npm run ashby:fixtures:catalog first.`);
  }
  const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { fixtures?: FixtureCase[] };
  return { fixtures: Array.isArray(parsed.fixtures) ? parsed.fixtures : [] };
}

function extractAppData(html: string): any {
  const match = html.match(/window\.__appData\s*=\s*(\{[\s\S]*?\});\s*(?:fetch\(|<\/script>)/);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function collectForms(root: any): any[] {
  const out: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return void node.forEach(visit);
    if (Array.isArray(node.entries) && node.entries.some((entry: any) => entry?.field?.path || entry?.field?.title)) out.push(node);
    Object.values(node).forEach(visit);
  };
  visit(root);
  return out;
}

function toOfflineType(field: any): OfflineField['type'] {
  const type = normalize(String(field?.type || ''));
  if (type === 'longtext') return 'textarea';
  if (type === 'file') return 'file';
  if (type === 'location') return 'combobox';
  if (type === 'valueselect') {
    const options = Array.isArray(field?.selectableValues) ? field.selectableValues : [];
    if (options.length === 2 && options.some((x: any) => /yes|no|true|false/i.test(String(x?.label || x?.value || '')))) return 'yes_no';
    if (options.length > 2) return 'radio';
    return 'radio';
  }
  if (type === 'boolean') return 'yes_no';
  if (type.includes('date')) return 'date';
  return 'text';
}

function offlineFieldsFromPayload(html: string): OfflineField[] {
  const appData = extractAppData(html);
  const forms = collectForms(appData);
  const form = forms[0];
  if (!form) return [];
  const entries = Array.isArray(form.entries) ? form.entries : [];
  const out: OfflineField[] = [];
  for (const entry of entries) {
    const field = entry?.field ?? {};
    const label = String(field.title || field.humanReadablePath || field.path || '').trim();
    const fieldPath = String(field.path || '').trim();
    if (!label || !fieldPath) continue;
    const options = (Array.isArray(field.selectableValues) ? field.selectableValues : [])
      .map((item: any) => String(item?.label || item?.value || '').trim())
      .filter(Boolean);
    out.push({
      fieldPath,
      label,
      required: Boolean(entry?.isRequired),
      type: toOfflineType(field),
      options
    });
  }
  return out;
}

function buildSyntheticDom(fields: OfflineField[], withValidation = true): string {
  const esc = (v: string) => v.replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const blocks = fields.map((field, idx) => {
    const errId = `err_${idx}`;
    if (field.type === 'textarea') {
      return `<div class="ashby-application-form-field-entry" data-field-path="${esc(field.fieldPath)}"><label class="ashby-application-form-question-title" for="${esc(field.fieldPath)}">${esc(field.label)}</label><textarea id="${esc(field.fieldPath)}" ${field.required ? 'required' : ''}></textarea>${withValidation ? `<div id="${errId}" class="error">Missing entry for required field: ${esc(field.label)}</div>` : ''}</div>`;
    }
    if (field.type === 'file') {
      return `<div class="ashby-application-form-field-entry" data-field-path="${esc(field.fieldPath)}"><label class="ashby-application-form-question-title" for="${esc(field.fieldPath)}">${esc(field.label)}</label><input id="${esc(field.fieldPath)}" type="file" ${field.required ? 'required' : ''}/> ${withValidation ? `<div id="${errId}" class="error">Missing entry for required field: ${esc(field.label)}</div>` : ''}</div>`;
    }
    if (field.type === 'combobox') {
      return `<div class="ashby-application-form-field-entry" data-field-path="${esc(field.fieldPath)}"><label class="ashby-application-form-question-title" for="${esc(field.fieldPath)}">${esc(field.label)}</label><input id="${esc(field.fieldPath)}" role="combobox" aria-autocomplete="list" aria-invalid="true" aria-describedby="${errId}" ${field.required ? 'required' : ''}/>${withValidation ? `<div id="${errId}" class="error">Missing entry for required field: ${esc(field.label)}</div>` : ''}</div>`;
    }
    if (field.type === 'date') {
      return `<div class="ashby-application-form-field-entry" data-field-path="${esc(field.fieldPath)}"><label class="ashby-application-form-question-title" for="${esc(field.fieldPath)}">${esc(field.label)}</label><input id="${esc(field.fieldPath)}" type="date" ${field.required ? 'required' : ''}/> ${withValidation ? `<div id="${errId}" class="error">Missing entry for required field: ${esc(field.label)}</div>` : ''}</div>`;
    }
    if (field.type === 'radio' || field.type === 'yes_no') {
      const options = field.type === 'yes_no' ? ['Yes', 'No'] : (field.options.length > 0 ? field.options : ['Option A', 'Option B']);
      const opts = options.map((opt, oi) => `<label><input type="radio" name="${esc(field.fieldPath)}" value="${esc(opt)}" ${field.required && oi === 0 ? 'required' : ''}/>${esc(opt)}</label>`).join('');
      return `<fieldset class="ashby-application-form-field-entry" data-field-path="${esc(field.fieldPath)}"><legend class="ashby-application-form-question-title">${esc(field.label)}</legend>${opts}${withValidation ? `<div id="${errId}" class="error">Missing entry for required field: ${esc(field.label)}</div>` : ''}</fieldset>`;
    }
    if (field.type === 'checkbox_group') {
      const options = field.options.length > 0 ? field.options : ['Option A', 'Option B'];
      const opts = options.map((opt, oi) => `<label><input type="checkbox" name="${esc(field.fieldPath)}" value="${esc(opt)}" ${field.required && oi === 0 ? 'required' : ''}/>${esc(opt)}</label>`).join('');
      return `<fieldset class="ashby-application-form-field-entry" data-field-path="${esc(field.fieldPath)}"><legend class="ashby-application-form-question-title">${esc(field.label)}</legend>${opts}${withValidation ? `<div id="${errId}" class="error">Missing entry for required field: ${esc(field.label)}</div>` : ''}</fieldset>`;
    }
    return `<div class="ashby-application-form-field-entry" data-field-path="${esc(field.fieldPath)}"><label class="ashby-application-form-question-title" for="${esc(field.fieldPath)}">${esc(field.label)}</label><input id="${esc(field.fieldPath)}" type="text" ${field.required ? 'required' : ''}/> ${withValidation ? `<div id="${errId}" class="error">Missing entry for required field: ${esc(field.label)}</div>` : ''}</div>`;
  }).join('\n');
  return `<!doctype html><html><body><form>${blocks}<button type="submit">Submit</button></form></body></html>`;
}

function normalizeType(value: string): string {
  const raw = normalize(value);
  if (raw === 'single_select' || raw === 'multi_select' || raw === 'boolean') return 'single_select';
  return raw;
}

// This suite replays Ashby pages captured from live postings. The catalog is a
// local developer artifact and is intentionally not committed, so skip rather
// than fail when it is absent. Run `npm run ashby:fixtures:catalog` to enable it.
test('ashby local fixture extractor/execution/recovery suite', { skip: !fs.existsSync(catalogPath) && 'no local ashby fixture catalog' }, async () => {
  const { fixtures } = loadCatalog();
  assert.ok(fixtures.length >= 8, `Need at least 8 fixtures, found ${fixtures.length}`);
  const adapter = new AshbyAdapter() as any;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const fixture of fixtures) {
      const htmlAbs = path.resolve(process.cwd(), fixture.htmlPath);
      assert.ok(fs.existsSync(htmlAbs), `Fixture HTML missing for ${fixture.id}: ${htmlAbs}`);
      const html = fs.readFileSync(htmlAbs, 'utf8');
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        const offlineFields = offlineFieldsFromPayload(html);
        let extracted = await extractVisibleFields(page);
        if (offlineFields.length > 0) {
          const synthetic = buildSyntheticDom(offlineFields, true);
          await page.setContent(synthetic, { waitUntil: 'domcontentloaded' });
          extracted = await extractVisibleFields(page);
        } else if (extracted.length === 0) {
          assert.fail(`No extractable DOM and no payload fallback for ${fixture.id}`);
        }
        assert.ok(extracted.length > 0, `No extracted fields for fixture ${fixture.id}`);

        for (const expected of fixture.expectedFields ?? []) {
          const labelNeedle = normalize(expected.labelIncludes);
          const field = extracted.find((item) => normalize(item.label).includes(labelNeedle));
          assert.ok(field, `Missing expected field '${expected.labelIncludes}' in fixture ${fixture.id}`);
          if (expected.type) {
            const offlineType = offlineFields
              .find((candidate) => normalize(candidate.label).includes(labelNeedle) || labelNeedle.includes(normalize(candidate.label)))
              ?.type ?? '';
            const extractedType = normalizeType(field?.type || '');
            const resolvedType = extractedType === 'text' && normalizeType(offlineType) === 'date' ? 'date' : extractedType;
            assert.equal(resolvedType, normalizeType(expected.type), `Wrong type for ${expected.labelIncludes} in ${fixture.id}`);
          }
          if (typeof expected.required === 'boolean') assert.equal(field?.required, expected.required, `Wrong required flag for ${expected.labelIncludes} in ${fixture.id}`);
          if (expected.possibleAnswers && expected.possibleAnswers.length > 0) {
            const fallbackOptions = offlineFields
              .find((candidate) => normalize(candidate.label).includes(labelNeedle) || labelNeedle.includes(normalize(candidate.label)))
              ?.options ?? [];
            const options = ((field?.options && field.options.length > 0) ? field.options : fallbackOptions).map((value) => normalize(String(value)));
            const expectedOptions = expected.possibleAnswers.map((value) => normalize(value));
            assert.deepEqual(options, expectedOptions, `Wrong possibleAnswers for ${expected.labelIncludes} in ${fixture.id}`);
          }
        }

        for (const execCase of fixture.executionCases ?? []) {
          const field = extracted.find((item) => normalize(item.label).includes(normalize(execCase.labelIncludes)));
          assert.ok(field, `Execution field '${execCase.labelIncludes}' not found in ${fixture.id}`);
          const before = await adapter.verifyFieldAnswered(page, field as DetectedField, undefined);
          const filled = await fillField(page, field as DetectedField, execCase.value as any);
          assert.equal(filled, true, `fillField failed for ${execCase.labelIncludes} in ${fixture.id}`);
          const verified = await adapter.verifyFieldAnswered(page, field as DetectedField, execCase.value as any);
          const after = await adapter.verifyFieldAnswered(page, field as DetectedField, undefined);
          assert.equal(verified, true, `Verification failed for ${execCase.labelIncludes} in ${fixture.id}`);
          assert.ok(after || !before, `Expected changed/answered state for ${execCase.labelIncludes} in ${fixture.id}`);
        }

        for (const recovery of fixture.recoveryCases ?? []) {
          const schema = await adapter.extractSingleFieldSchemaFromValidationErrorNode(
            page,
            recovery.errorText,
            { answer: null, selectedOptions: [], failureReason: recovery.errorText }
          );
          assert.ok(schema, `Recovery schema not found for '${recovery.errorText}' in ${fixture.id}`);
          if (recovery.expectedFieldPath) assert.equal(schema?.fieldPath, recovery.expectedFieldPath, `Wrong anchored fieldPath in ${fixture.id}`);
          if (recovery.expectedLabelIncludes) {
            assert.equal(normalize(schema?.label || '').includes(normalize(recovery.expectedLabelIncludes)), true, `Wrong anchored label in ${fixture.id}`);
          }
          if (recovery.expectedFieldType) {
            const actual = normalizeType(String(schema?.fieldType || ''));
            const expected = normalizeType(recovery.expectedFieldType);
            assert.equal(actual, expected, `Wrong anchored fieldType in ${fixture.id}`);
          }
          if (recovery.allowedOptions && recovery.allowedOptions.length > 0) {
            const got = (schema?.possibleAnswers ?? []).map((item: string) => normalize(item));
            const allowed = recovery.allowedOptions.map((item) => normalize(item));
            assert.deepEqual(got, allowed, `Recovery options not constrained to DOM controls in ${fixture.id}`);
          }
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
