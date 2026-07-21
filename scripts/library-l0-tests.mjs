#!/usr/bin/env node
// Deterministic Phase L0 validation for the governed measurement library.
// This suite is intentionally dependency-free and read-only: it verifies the
// checked-in contracts without generating or normalizing library data.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const libraryDir = path.join(appDir, 'library');
let failures = 0;

const REQUIRED_DIRECTORIES = [
  'schemas', 'intake/projects', 'intake/exports', 'intake/images',
  'styles/pending', 'styles/approved',
  'features/definitions', 'features/pending', 'features/approved',
  'landmarks/definitions', 'landmarks/pending-evidence', 'landmarks/approved-evidence',
  'pom-definitions', 'pom-values/pending', 'pom-values/approved',
  'qa-cases/draft', 'qa-cases/approved', 'qa-cases/held-out',
  'corrections/geometry', 'corrections/measurement', 'corrections/reviewed',
  'similarity-index/generated',
  'reports/intake', 'reports/conflicts', 'reports/coverage', 'reports/evaluation',
  'snapshots', 'references',
];

const REQUIRED_SCHEMAS = [
  'library-manifest.schema.json', 'style.schema.json',
  'feature-definition.schema.json', 'style-feature.schema.json',
  'landmark-definition.schema.json', 'style-landmark-evidence.schema.json',
  'pom-definition-reference.schema.json', 'pom-value-set.schema.json',
  'qa-case.schema.json', 'correction.schema.json', 'similarity-index.schema.json',
  'intake-candidate.schema.json', 'identity-decisions.schema.json',
  'project-intake.schema.json', 'evidence-bundles.schema.json',
];

const REQUIRED_JSON = [
  'manifest.json', 'intake/fingerprints.json', 'intake/identity-decisions.json',
  'pom-definitions/contract-reference.json',
  'pom-definitions/aliases-pending.json',
  'pom-definitions/aliases-approved.json',
  'references/enums.json', 'references/size-systems.json',
  'similarity-index/config.json',
];

function check(condition, label, detail = '') {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function readJson(relativePath) {
  const absolutePath = path.join(appDir, relativePath);
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    check(false, `${relativePath} is valid JSON`, error.message);
    return null;
  }
}

function walkJson(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? walkJson(absolute) : (entry.name.endsWith('.json') ? [absolute] : []);
    });
}

function fingerprint(relativePath) {
  return `sha256:${createHash('sha256').update(readFileSync(path.join(appDir, relativePath))).digest('hex')}`;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Small Draft 2020-12 subset sufficient for the checked-in L0 schemas. It
// supports local refs, composition, conditionals, objects, arrays and scalar
// constraints used by this project. Unsupported keywords remain annotations.
export function validateSchema(value, schema, root = schema, at = '$') {
  const errors = [];
  if (!isObject(schema)) return [`${at}: schema must be an object`];

  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) return [`${at}: only local schema refs are supported (${schema.$ref})`];
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
    return target ? validateSchema(value, target, root, at) : [`${at}: unresolved ref ${schema.$ref}`];
  }
  if (schema.const !== undefined && !sameJson(value, schema.const)) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate) => sameJson(candidate, value))) errors.push(`${at}: is not in enum`);

  const types = schema.type == null ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${at}: expected ${types.join('|')}`);
    return errors;
  }

  if (schema.oneOf) {
    const passes = schema.oneOf.filter((candidate) => validateSchema(value, candidate, root, at).length === 0).length;
    if (passes !== 1) errors.push(`${at}: must match exactly one oneOf branch (matched ${passes})`);
  }
  if (schema.anyOf && !schema.anyOf.some((candidate) => validateSchema(value, candidate, root, at).length === 0)) {
    errors.push(`${at}: must match at least one anyOf branch`);
  }
  for (const candidate of schema.allOf || []) errors.push(...validateSchema(value, candidate, root, at));
  if (schema.if && validateSchema(value, schema.if, root, at).length === 0 && schema.then) {
    errors.push(...validateSchema(value, schema.then, root, at));
  } else if (schema.if && schema.else) {
    errors.push(...validateSchema(value, schema.else, root, at));
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${at}: invalid date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${at}: items are not unique`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, root, `${at}[${index}]`)));
  }
  if (isObject(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateSchema(item, schema.properties[key], root, `${at}.${key}`));
      else if (isObject(schema.additionalProperties)) errors.push(...validateSchema(item, schema.additionalProperties, root, `${at}.${key}`));
      else if (schema.additionalProperties === false && key !== '$schema') errors.push(`${at}: unexpected property ${key}`);
    }
  }
  return errors;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function entriesOf(document, keys) {
  if (Array.isArray(document)) return document;
  for (const key of keys) if (Array.isArray(document?.[key])) return document[key];
  return [];
}

function validateAliases(approvedDocument, pendingDocument, conceptIds) {
  const approved = entriesOf(approvedDocument, ['aliases', 'mappings', 'entries']);
  const pending = entriesOf(pendingDocument, ['aliases', 'mappings', 'entries']);
  const approvedTerms = new Set();

  for (const [index, item] of approved.entries()) {
    const status = item.status || item.review_status || 'approved';
    check(status === 'approved', `approved alias ${index + 1} has approved status`);
    const concept = item.concept_id || item.canonical_concept_id;
    check(typeof concept === 'string' && concept.length > 0, `approved alias ${index + 1} has one canonical concept`);
    if (concept) check(conceptIds.has(concept), `approved alias ${index + 1} targets a registered concept`);
    const candidates = item.candidate_concept_ids || item.candidates || [];
    check(!Array.isArray(candidates) || candidates.length <= 1, `approved alias ${index + 1} is not ambiguous`);
    const term = String(item.alias || item.raw_term || item.term || '').trim().toLowerCase();
    check(term.length > 0, `approved alias ${index + 1} has a term`);
    if (term) {
      check(!approvedTerms.has(term), `approved alias term is unique (${term})`);
      approvedTerms.add(term);
    }
  }
  for (const [index, item] of pending.entries()) {
    const status = item.status || item.review_status || 'pending';
    check(status !== 'approved', `pending alias ${index + 1} is not approved`);
    const term = String(item.alias || item.raw_term || item.term || '').trim().toLowerCase();
    if (term) check(!approvedTerms.has(term), `pending alias is absent from approved boundary (${term})`);
    const candidates = item.candidate_concept_ids || item.candidates || [];
    check(Array.isArray(candidates) && candidates.every((concept) => conceptIds.has(concept)), `pending alias ${index + 1} candidates are registered concepts`);
  }
}

function main() {
  check(existsSync(libraryDir), 'library/ exists');
  check(existsSync(path.join(libraryDir, 'README.md')), 'library/README.md exists');
  for (const relative of REQUIRED_DIRECTORIES) {
    const absolute = path.join(libraryDir, relative);
    check(existsSync(absolute) && statSync(absolute).isDirectory(), `library/${relative}/ exists`);
  }
  for (const name of REQUIRED_SCHEMAS) check(existsSync(path.join(libraryDir, 'schemas', name)), `schema exists: ${name}`);
  for (const relative of REQUIRED_JSON) check(existsSync(path.join(libraryDir, relative)), `library/${relative} exists`);

  const parsed = new Map();
  for (const absolute of walkJson(libraryDir)) {
    const relative = path.relative(appDir, absolute);
    const value = readJson(relative);
    if (value !== null) parsed.set(relative, value);
  }
  check(parsed.size === walkJson(libraryDir).length, `all ${walkJson(libraryDir).length} library JSON files parse`);

  for (const name of REQUIRED_SCHEMAS) {
    const schema = parsed.get(`library/schemas/${name}`);
    check(schema?.$schema === 'https://json-schema.org/draft/2020-12/schema', `${name} declares JSON Schema 2020-12`);
    check(schema?.type === 'object', `${name} has an object root contract`);
    check(Array.isArray(schema?.required), `${name} declares required fields`);
  }

  const manifest = parsed.get('library/manifest.json');
  const manifestSchema = parsed.get('library/schemas/library-manifest.schema.json');
  if (manifest && manifestSchema) {
    const errors = validateSchema(manifest, manifestSchema);
    check(errors.length === 0, 'manifest validates against library-manifest.schema.json', errors.slice(0, 4).join('; '));
  }

  const pendingCandidate = parsed.get('library/intake/exports/measurements-size-l.pending.json');
  const pendingCandidateSchema = parsed.get('library/schemas/intake-candidate.schema.json');
  if (pendingCandidate && pendingCandidateSchema) {
    const errors = validateSchema(pendingCandidate, pendingCandidateSchema);
    check(errors.length === 0, 'generated pending corpus validates against intake-candidate.schema.json', errors.slice(0, 4).join('; '));
  }

  const identityDecisions = parsed.get('library/intake/identity-decisions.json');
  const identityDecisionsSchema = parsed.get('library/schemas/identity-decisions.schema.json');
  if (identityDecisions && identityDecisionsSchema) {
    const errors = validateSchema(identityDecisions, identityDecisionsSchema);
    check(errors.length === 0, 'identity decisions validate against identity-decisions.schema.json', errors.slice(0, 4).join('; '));
  }

  const contract = parsed.get('library/pom-definitions/contract-reference.json');
  const contractSchema = parsed.get('library/schemas/pom-definition-reference.schema.json');
  if (contract && contractSchema) {
    const errors = validateSchema(contract, contractSchema);
    check(errors.length === 0, 'contract reference validates against pom-definition-reference.schema.json', errors.slice(0, 4).join('; '));
  }

  const expectedFiles = {
    pom: 'auto_mode_rules/pom-template.json',
    anchor: 'auto_mode_rules/anchor-schema.json',
  };
  for (const [kind, relative] of Object.entries(expectedFiles)) {
    const actual = fingerprint(relative);
    const manifestRef = manifest?.contracts?.[kind];
    const contractRef = contract?.contracts?.[kind];
    check(manifestRef?.file === relative, `manifest ${kind} contract points to ${relative}`);
    check(manifestRef?.fingerprint === actual, `manifest ${kind} SHA-256 matches current contract`);
    check((contractRef?.file || contractRef?.path) === relative, `contract reference ${kind} points to ${relative}`);
    check(contractRef?.fingerprint === actual, `contract reference ${kind} SHA-256 matches current contract`);
    check(contractRef?.fingerprint === manifestRef?.fingerprint, `${kind} fingerprint is identical across manifest and registry`);
  }

  const versions = readJson('auto_mode_rules/version.json');
  check(manifest?.contracts?.pom?.version === versions?.template_version, 'manifest POM version matches version.json');
  check(manifest?.contracts?.anchor?.version === versions?.anchor_version, 'manifest anchor version matches version.json');
  check(contract?.contracts?.pom?.version === versions?.template_version, 'registry POM version matches version.json');
  check(contract?.contracts?.anchor?.version === versions?.anchor_version, 'registry anchor version matches version.json');

  const templateRows = readJson('auto_mode_rules/pom-template.json')?.rows || [];
  const concepts = entriesOf(contract, ['concepts', 'registry', 'pom_concepts']);
  check(concepts.length === 18, 'global registry contains exactly POM concepts 1-18');
  const numbers = concepts.map((item) => item.pom_number);
  check(new Set(numbers).size === numbers.length, 'global registry has no reused POM number');
  check(sameJson([...numbers].sort((a, b) => a - b), Array.from({ length: 18 }, (_, index) => index + 1)), 'global registry numbers are immutable 1-18');
  check(new Set(concepts.map((item) => item.concept_id)).size === concepts.length, 'global registry concept ids are unique');
  check(contract?.numbering_policy?.immutable === true, 'global numbering policy is immutable');
  check(contract?.numbering_policy?.core_range?.first === 1 && contract?.numbering_policy?.core_range?.last === 18, 'global numbering policy reserves core range 1-18');
  check(contract?.numbering_policy?.next_assignable_number === 19, 'global numbering policy keeps 17 and 18 in the core range and assigns 19 next');
  check(contract?.numbering_policy?.never_reuse_retired_numbers === true, 'retired POM numbers cannot be reused');
  check(contract?.numbering_policy?.joins_use === 'concept_id', 'library joins use stable concept_id');

  for (const row of templateRows) {
    const pom = Number(row.id);
    const concept = concepts.find((item) => item.pom_number === pom);
    check(!!concept, `POM ${pom} has a global concept`);
    if (!concept) continue;
    check(concept.canonical_name_en === row.name, `POM ${pom} English label mirrors live contract`);
    check(concept.canonical_name_zh === row.zh, `POM ${pom} Chinese label mirrors live contract`);
    check(concept.view === row.view, `POM ${pom} view mirrors live contract`);
    check(sameJson(concept.required_anchors, row.requiredAnchors), `POM ${pom} anchors mirror live contract`);
    check(concept.status === 'active_contract', `POM ${pom} is active_contract`);
  }

  // US-037 / ADR 0032: POM 17 (neckline) was promoted from
  // reserved_pending_definition to an active concept, and POM 18 (armhole)
  // was newly defined. Both now carry full definitions mirrored by the
  // template-mirror loop above.
  const neckline = concepts.find((item) => item.pom_number === 17);
  check(neckline?.concept_id === 'neckline_length', 'POM 17 concept is neckline_length');
  check(neckline?.canonical_name_en === 'Neckline length', 'POM 17 canonical label is Neckline length');
  check(neckline?.status === 'active_contract', 'POM 17 is now an active_contract concept');
  check(sameJson(neckline?.required_anchors, ['171', '172']), 'POM 17 uses anchors 171/172');
  const armhole = concepts.find((item) => item.pom_number === 18);
  check(armhole?.concept_id === 'armhole_curve_length', 'POM 18 concept is armhole_curve_length');
  check(armhole?.canonical_name_en === 'Armhole curve length', 'POM 18 canonical label is Armhole curve length');
  check(armhole?.status === 'active_contract', 'POM 18 is now an active_contract concept');
  check(sameJson(armhole?.required_anchors, ['181', '182']), 'POM 18 uses anchors 181/182');

  validateAliases(
    parsed.get('library/pom-definitions/aliases-approved.json'),
    parsed.get('library/pom-definitions/aliases-pending.json'),
    new Set(concepts.map((item) => item.concept_id)),
  );

  const enums = parsed.get('library/references/enums.json');
  const requiredEnumValues = {
    source_types: ['saved-project-json', 'measurement-spec-xlsx', 'source-image'],
    record_statuses: ['pending', 'approved', 'superseded', 'retired'],
    concept_statuses: ['active_contract', 'approved', 'reserved_pending_definition', 'retired'],
    review_statuses: ['pending', 'approved', 'rejected', 'superseded'],
    feature_evidence_states: ['known', 'absent', 'unknown'],
    pom_membership_statuses: ['applicable_present', 'applicable_missing', 'not_applicable', 'unknown_not_provided', 'pending_term_mapping'],
    units: ['in', 'cm', 'mm'],
    identity_types: ['style-version', 'pom-concept', 'pom-value-set'],
  };
  for (const [key, requiredValues] of Object.entries(requiredEnumValues)) {
    const values = enums?.[key];
    check(Array.isArray(values) && new Set(values).size === values.length, `${key} is a unique enum`);
    check(requiredValues.every((value) => values?.includes(value)), `${key} contains required L0 values`);
  }

  const sizeSystems = entriesOf(parsed.get('library/references/size-systems.json'), ['size_systems']);
  const sizeSystem = sizeSystems.find((item) => item.size_system_id === 'crossian-alpha-depth-v1');
  const expectedSizes = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'M2', 'L2', 'XL2', '2XL2', '3XL2', '4XL2', '5XL2'];
  check(!!sizeSystem, 'crossian-alpha-depth-v1 size system exists');
  check(sameJson(sizeSystem?.members?.map((item) => item.size_code), expectedSizes), 'size system preserves exact current export membership and order');

  const similarity = parsed.get('library/similarity-index/config.json');
  check(similarity?.enabled === false, 'Phase L0 similarity ranking stays disabled');
  check(similarity?.approved_records_only === true, 'similarity configuration excludes pending records');
  check(similarity?.deterministic === true, 'similarity configuration is deterministic');

  if (failures) {
    console.error(`FAIL  library-l0-tests: ${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('PASS  library-l0-tests');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
