#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), '.playwright-mcp/ashby-fixtures');
const outPath = path.join(root, 'catalog.json');
const requiredPatterns = [
  'radio_groups',
  'checkbox_groups',
  'yes_no_button_groups',
  'comboboxes',
  'button_only_option_groups',
  'date_pickers',
  'file_upload',
  'location_availability',
  'office_preference',
  'eeo_fields',
  'custom_required_fields'
];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function isUsableAshbySnapshot(html) {
  const lower = html.toLowerCase();
  if (lower.includes("about:blank")) return false;
  const hasQuestion =
    lower.includes("ashby-application-form-question-title") ||
    lower.includes("data-field-path") ||
    lower.includes("type=\"radio\"") ||
    lower.includes("type=\"checkbox\"") ||
    lower.includes("role=\"combobox\"") ||
    lower.includes("type=\"file\"") ||
    lower.includes("type=\"date\"");
  return hasQuestion;
}

function extractAppData(html) {
  const match = html.match(/window\.__appData\s*=\s*(\{[\s\S]*?\});\s*(?:fetch\(|<\/script>)/);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function collectFormModels(root) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const obj = node;
    if (Array.isArray(obj.entries) && obj.entries.some((entry) => entry?.field?.path || entry?.field?.title)) {
      out.push(obj);
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(root);
  return out;
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mapFieldTypeFromSchema(field) {
  const type = normalize(field?.type).toLowerCase();
  if (type === 'longtext') return 'textarea';
  if (type === 'file') return 'file';
  if (type === 'location') return 'single_select';
  if (type === 'valueselect') {
    const options = Array.isArray(field?.selectableValues) ? field.selectableValues : [];
    return options.length > 2 ? 'single_select' : 'boolean';
  }
  if (type === 'boolean') return 'boolean';
  if (type.includes('date')) return 'date';
  return 'text';
}

function optionsFromSchema(field) {
  const values = Array.isArray(field?.selectableValues) ? field.selectableValues : [];
  return values
    .map((item) => normalize(item?.label || item?.value || ''))
    .filter(Boolean);
}

function buildSchemaAssertionsFromPayload(html) {
  const appData = extractAppData(html);
  if (!appData) return { expectedFields: [], executionCases: [], recoveryCases: [] };
  const forms = collectFormModels(appData);
  const selected = forms[0];
  if (!selected) return { expectedFields: [], executionCases: [], recoveryCases: [] };
  const entries = Array.isArray(selected.entries) ? selected.entries : [];
  const expectedFields = [];
  const executionCases = [];
  const recoveryCases = [];

  for (const entry of entries) {
    const field = entry?.field ?? {};
    const label = normalize(field.title || field.humanReadablePath || field.path || '');
    const fieldPath = normalize(field.path || '');
    if (!label || !fieldPath) continue;
    const mappedType = mapFieldTypeFromSchema(field);
    const possibleAnswers = optionsFromSchema(field);
    expectedFields.push({
      labelIncludes: label,
      type: mappedType,
      required: Boolean(entry?.isRequired),
      possibleAnswers
    });
    if (executionCases.length < 6) {
      if (mappedType === 'text') executionCases.push({ labelIncludes: label, value: 'Fixture Value' });
      else if (mappedType === 'textarea') executionCases.push({ labelIncludes: label, value: 'Fixture narrative answer.' });
      else if (mappedType === 'boolean') executionCases.push({ labelIncludes: label, value: true });
      else if (mappedType === 'single_select' && possibleAnswers.length > 0) executionCases.push({ labelIncludes: label, value: possibleAnswers[0] });
    }
    if (recoveryCases.length < 2 && Boolean(entry?.isRequired) && possibleAnswers.length > 1) {
      recoveryCases.push({
        errorText: `Missing entry for required field: ${label}`,
        expectedFieldPath: fieldPath,
        expectedLabelIncludes: label,
        expectedFieldType: mappedType === 'boolean' ? 'yes_no' : 'radio',
        allowedOptions: possibleAnswers
      });
    }
  }
  return {
    expectedFields: expectedFields.slice(0, 20),
    executionCases: executionCases.slice(0, 6),
    recoveryCases: recoveryCases.slice(0, 2)
  };
}

function tagPatterns(html) {
  const lower = html.toLowerCase();
  const tags = new Set();
  if ((lower.match(/type=['\"]radio['\"]/g) || []).length > 1 || lower.includes("role='radio'") || lower.includes('role="radio"')) tags.add('radio_groups');
  if ((lower.match(/type=['\"]checkbox['\"]/g) || []).length > 1 || lower.includes("role='checkbox'") || lower.includes('role="checkbox"')) tags.add('checkbox_groups');
  if (/\byes\b/.test(lower) && /\bno\b/.test(lower) && lower.includes('<button')) tags.add('yes_no_button_groups');
  if (lower.includes('role="combobox"') || lower.includes("role='combobox'") || lower.includes('aria-autocomplete')) tags.add('comboboxes');
  if (lower.includes('<button') && !lower.includes("type='radio'") && !lower.includes('type="radio"') && !lower.includes("type='checkbox'") && !lower.includes('type="checkbox"')) tags.add('button_only_option_groups');
  if (lower.includes('type="date"') || lower.includes("type='date'") || lower.includes('mm/dd/yyyy') || lower.includes('pick date')) tags.add('date_pickers');
  if (lower.includes('type="file"') || lower.includes("type='file'")) tags.add('file_upload');
  if (lower.includes('available to work from') || lower.includes('location(s)')) tags.add('location_availability');
  if (lower.includes('office') && (lower.includes('work from') || lower.includes('preference'))) tags.add('office_preference');
  if (lower.includes('equal employment') || lower.includes('eeo') || lower.includes('gender') || lower.includes('ethnicity') || lower.includes('veteran') || lower.includes('disability')) tags.add('eeo_fields');
  if (lower.includes('required') || lower.includes('aria-invalid="true"') || lower.includes("aria-invalid='true'")) tags.add('custom_required_fields');
  return Array.from(tags).sort();
}

function main() {
  fs.mkdirSync(root, { recursive: true });
  const files = walk(root);
  const fixtures = files.map((file) => {
    const html = fs.readFileSync(file, 'utf8');
    if (!isUsableAshbySnapshot(html)) return null;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const id = rel.replace(/\.html$/i, '').replace(/[\/:]+/g, '__');
    const assertions = buildSchemaAssertionsFromPayload(html);
    return {
      id,
      htmlPath: path.relative(process.cwd(), file),
      patternTags: tagPatterns(html),
      expectedFields: assertions.expectedFields,
      executionCases: assertions.executionCases,
      recoveryCases: assertions.recoveryCases
    };
  }).filter(Boolean);

  const coverage = Object.fromEntries(requiredPatterns.map((pattern) => [pattern, fixtures.some((f) => f.patternTags.includes(pattern))]));
  const payload = {
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    requiredPatterns,
    coverage,
    fixtures
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  const missing = requiredPatterns.filter((pattern) => !coverage[pattern]);
  console.log(`ashby fixture catalog written: ${path.relative(process.cwd(), outPath)} (fixtures=${fixtures.length})`);
  if (fixtures.length < 8) {
    console.error(`coverage gate failed: need at least 8 fixtures, found ${fixtures.length}`);
    process.exitCode = 1;
    return;
  }
  if (missing.length > 0) {
    console.warn(`coverage warning: missing pattern tags: ${missing.join(', ')}`);
  }
}

main();
