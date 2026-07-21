#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE_CODES = ['S','M','L','XL','2XL','3XL','4XL','5XL','M2','L2','XL2','2XL2','3XL2','4XL2','5XL2'];
const CORE_HEADERS = ['POM', 'Description - English', 'Description - Chinese', 'TOL'];

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fp = bytes => `sha256:${sha(bytes)}`;
const clone = value => JSON.parse(JSON.stringify(value));
const xmlText = s => String(s || '').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function parseCsv(text) {
  const rows = []; let field = ''; let row = []; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; if (field || row.length) { row.push(field); rows.push(row); } field = ''; row = []; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() || [];
  return rows.map(cols => Object.fromEntries(header.map((h, i) => [h.trim(), cols[i] ?? ''])));
}

function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not_zip');
  const total = bytes.readUInt16LE(eocd + 10); let at = bytes.readUInt32LE(eocd + 16); const out = new Map();
  for (let i = 0; i < total; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('bad_central_directory');
    const method = bytes.readUInt16LE(at + 10); const compressed = bytes.readUInt32LE(at + 20); const size = bytes.readUInt32LE(at + 24);
    const nameLen = bytes.readUInt16LE(at + 28); const extraLen = bytes.readUInt16LE(at + 30); const commentLen = bytes.readUInt16LE(at + 32); const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const localName = bytes.readUInt16LE(local + 26); const localExtra = bytes.readUInt16LE(local + 28); const start = local + 30 + localName + localExtra;
    const packed = bytes.subarray(start, start + compressed);
    if (method !== 0 && method !== 8) throw new Error(`unsupported_zip_method:${method}`);
    const data = method === 0 ? packed : inflateRawSync(packed);
    if (data.length !== size) throw new Error(`zip_size_mismatch:${name}`);
    out.set(name, data); at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function workbookCells(bytes) {
  const zip = zipEntries(bytes); const wb = zip.get('xl/workbook.xml')?.toString('utf8');
  const rels = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!wb || !rels) throw new Error('missing_workbook_parts');
  const relMap = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]));
  const sharedXml = zip.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => xmlText(m[1]));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    const target = relMap.get(m[2]); if (!target) continue;
    const entry = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = zip.get(entry)?.toString('utf8') || '';
    const cells = new Map();
    for (const c of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = /\br="([^"]+)"/.exec(c[1])?.[1]; if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(c[1])?.[1]; const body = c[2]; const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      let value = type === 's' ? shared[Number(raw)] : type === 'inlineStr' ? xmlText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1]) : xmlText(raw);
      cells.set(ref, { value, formula: xmlText(/<f[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1] || '') || null });
    }
    sheets.push({ name: xmlText(m[1]), cells, zip });
  }
  return sheets;
}

const colNumber = letters => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const colLetters = n => { let s = ''; while (n) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26); } return s; };
function rowValues(sheet, row) {
  const refs = [...sheet.cells.keys()].filter(r => Number(r.match(/\d+$/)?.[0]) === row);
  const max = Math.max(0, ...refs.map(r => colNumber(r.match(/^[A-Z]+/)?.[0] || '')));
  return Array.from({ length: max }, (_, i) => sheet.cells.get(`${colLetters(i + 1)}${row}`)?.value ?? '');
}
function headerStatus(sheet) {
  const headers = rowValues(sheet, 3); const sizes = headers.slice(4);
  const ordered = sizes.length > 0 && sizes.every((s, i) => SIZE_CODES.indexOf(s) >= 0 && (i === 0 || SIZE_CODES.indexOf(s) > SIZE_CODES.indexOf(sizes[i - 1])));
  return { headers, eligible: JSON.stringify(headers.slice(0, 4)) === JSON.stringify(CORE_HEADERS) && ordered };
}

function walk(root) {
  const out = []; if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) { const p = path.join(root, name); const st = statSync(p); if (st.isDirectory()) out.push(...walk(p)); else if (/\.xlsx$/i.test(name) && !name.startsWith('~$')) out.push(p); }
  return out;
}

export function inventoryRoots(roots) {
  const seen = new Map(); const files = [];
  for (const root of roots) for (const p of walk(root.path)) {
    const bytes = readFileSync(p); const fingerprint = fp(bytes); let classification = 'unrelated_bom'; let reasons = []; let sheets = [];
    try {
      sheets = workbookCells(bytes).map(s => ({ name_observed: s.name, headers_row_3: rowValues(s, 3) }));
      const exact = workbookCells(bytes).find(s => s.name === 'Measurement Spec');
      const legacy = workbookCells(bytes).find(s => s.name.trim().toLowerCase() === 'measurement spec');
      if (exact && headerStatus(exact).eligible) classification = 'eligible_current_export';
      else if (legacy) { classification = 'legacy_measurement_candidate'; reasons.push(legacy.name === 'Measurement Spec' ? 'header_contract_mismatch' : 'sheet_name_not_exact'); }
      else if (/^SC\.xlsx$/i.test(path.basename(p)) || /TRIM STANDARDIZATION/i.test(path.basename(p))) classification = 'reference_only';
    } catch (error) { classification = 'unreadable_or_unsupported'; reasons = [String(error.message || error)]; }
    const duplicateOf = seen.get(fingerprint) || null; if (!duplicateOf) seen.set(fingerprint, `${root.id}:${path.relative(root.path, p)}`);
    files.push({ source_id: fingerprint, root_id: root.id, relative_path: path.relative(root.path, p), size_bytes: bytes.length, classification: duplicateOf ? 'duplicate' : classification, underlying_classification: classification, reason_codes: reasons.sort(), parse_eligible: classification === 'eligible_current_export' && !duplicateOf, duplicate_of: duplicateOf, sheets });
  }
  files.sort((a, b) => a.root_id.localeCompare(b.root_id) || a.relative_path.localeCompare(b.relative_path));
  return { inventory_version: 'measurement-source-inventory.v1', roots: roots.map(r => ({ root_id: r.id, path: path.resolve(r.path) })), files };
}

function parseTolerance(text) {
  const s = String(text || '').replace(/[±+\-]/g, '').trim(); if (!s) return null;
  const m = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(s); if (m) return Number(m[1] || 0) + Number(m[2]) / Number(m[3]);
  return /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}
function parseMeasurement(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const mixed = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(s);
  if (mixed && Number(mixed[3]) !== 0) return Number(mixed[1] || 0) + Number(mixed[2]) / Number(mixed[3]);
  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}
function registry() {
  const doc = JSON.parse(readFileSync(path.join(APP, 'library/pom-definitions/contract-reference.json'), 'utf8'));
  return new Map(doc.concepts.filter(c => c.pom_number <= 16).map(c => [c.pom_number, c]));
}

export function importCurrentWorkbook(file) {
  const bytes = readFileSync(file); const sheets = workbookCells(bytes); const sheet = sheets.find(s => s.name === 'Measurement Spec');
  if (!sheet || !headerStatus(sheet).eligible) throw new Error('unsupported_measurement_spec_contract');
  const headers = headerStatus(sheet).headers; const concepts = registry(); const records = []; const issues = new Set();
  const rows = [...sheet.cells.keys()].map(r => Number(r.match(/\d+$/)?.[0])).filter(n => n >= 4); const last = Math.max(3, ...rows);
  for (let row = 4; row <= last; row++) {
    const rawPom = sheet.cells.get(`A${row}`)?.value || null; const term = sheet.cells.get(`B${row}`)?.value || null; const n = Number(rawPom); const concept = Number.isInteger(n) && n >= 1 && n <= 16 ? concepts.get(n) : null;
    if (!concept) issues.add('unresolved_or_custom_pom_number');
    const tolText = sheet.cells.get(`D${row}`)?.value || null; const tol = parseTolerance(tolText); if (tolText && tol == null) issues.add('unparseable_tolerance');
    headers.slice(4).forEach((size, i) => {
      const ref = `${colLetters(5 + i)}${row}`; const cell = sheet.cells.get(ref); if (!cell) return;
      const value = cell.value === '' ? null : Number(cell.value); if (cell.value !== '' && !Number.isFinite(value)) issues.add('nonnumeric_measurement_value');
      records.push({ source_row: row, raw_style_id: sheet.cells.get('A2')?.value || null, raw_style_version: null, raw_source_file: path.basename(file), raw_pom_number: rawPom, raw_term: term, concept_id: concept?.concept_id || null, pom_number: concept?.pom_number || null, mapping_status: concept ? 'mapped_contract' : 'pending_term_mapping', size_code: size, value_in: Number.isFinite(value) ? value : null, source_text: cell.value || null, source_unit: 'in', tolerance_text: tolText, tolerance_value_in: tol, source_cell: ref, source_formula: cell.formula });
    });
  }
  const imageArtifacts = [...sheet.zip.entries()]
    .filter(([name]) => /^xl\/media\//.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data], index) => ({
      image_id: `export-image-${index + 1}`,
      role: 'annotated_export',
      fingerprint: fp(data),
      media_type: name.toLowerCase().endsWith('.png') ? 'image/png' : name.toLowerCase().endsWith('.jpg') || name.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream',
      source_entry: name,
    }));
  const hash = sha(bytes); const a2 = sheet.cells.get('A2')?.value || null;
  return { schema_version: 'pending-intake-candidate.v1', candidate_id: `intake-sha256-${hash}`, status: 'pending', source: { type: 'measurement-spec-xlsx', file_name: path.basename(file), fingerprint: `sha256:${hash}`, sheet: 'Measurement Spec' }, identity: { raw_style_id: a2, raw_style_version: null, resolution: 'pending_td_confirmation' }, records, image_artifacts: imageArtifacts, issues: [...issues].sort() };
}

export function importLegacySizeLCsv(file) {
  const bytes = readFileSync(file); const rows = parseCsv(bytes.toString('utf8')); const concepts = [...registry().values()]; const byTerm = new Map(concepts.flatMap(c => [[norm(c.canonical_name_en), c], ...c.aliases_approved.map(a => [norm(a), c])]));
  const aliasDecisions = JSON.parse(readFileSync(path.join(APP, 'library/pom-definitions/aliases-approved.json'), 'utf8'));
  const excludedTerms = new Set((aliasDecisions.never_merge || []).filter(item => item.status === 'approved_out_of_scope').map(item => norm(item.raw_term || item.normalized_term)));
  const records = []; const issues = new Set(['legacy_source_requires_td_review', 'source_unit_implicit_in']);
  for (const [i, row] of rows.entries()) {
    const normalizedTerm = norm(row.description_raw); const concept = byTerm.get(normalizedTerm); const excluded = !concept && excludedTerms.has(normalizedTerm); if (!concept && !excluded) issues.add('unresolved_legacy_terms');
    const value = row.size_l_in === '' ? null : Number(row.size_l_in); if (row.size_l_in !== '' && !Number.isFinite(value)) issues.add('nonnumeric_measurement_value');
    const tol = parseTolerance(row.tol_raw); if (row.tol_raw && tol == null) issues.add('unparseable_tolerance');
    records.push({ source_row: i + 2, raw_style_id: row.style_id || null, raw_style_version: row.version || null, raw_source_file: row.source_file || null, raw_pom_number: row.pom_no || null, raw_term: row.description_raw || null, concept_id: concept?.concept_id || null, pom_number: concept?.pom_number || null, mapping_status: concept ? 'mapped_contract' : excluded ? 'excluded_out_of_scope' : 'pending_term_mapping', size_code: 'L', value_in: Number.isFinite(value) ? value : null, source_text: row.size_l_raw || null, source_unit: 'in', tolerance_text: row.tol_raw || null, tolerance_value_in: tol, source_cell: null, source_formula: null });
  }
  const hash = sha(bytes);
  return { schema_version: 'pending-intake-candidate.v1', candidate_id: `intake-sha256-${hash}`, status: 'pending', source: { type: 'legacy-size-l-csv', file_name: path.basename(file), fingerprint: `sha256:${hash}`, sheet: null }, identity: { raw_style_id: null, raw_style_version: null, resolution: 'pending_td_confirmation' }, records, issues: [...issues].sort() };
}

function identityDecisionFor(fingerprint, document) {
  if (!document) return null;
  if (document.schema_version !== 'identity-decisions.v1' || !Array.isArray(document.decisions)) throw new Error('unsupported_identity_decisions_contract');
  const matches = document.decisions.filter(item => item?.source_fingerprint === fingerprint);
  if (matches.length > 1) {
    const identities = new Set(matches.map(item => `${item.style_id}\0${item.style_version}`));
    if (identities.size > 1) throw new Error('conflicting_identity_decisions');
    throw new Error('duplicate_identity_decisions');
  }
  const item = matches[0] || null;
  if (!item) return null;
  for (const key of ['decision_id', 'style_id', 'style_version', 'reviewed_by', 'reviewed_at']) if (!String(item[key] || '').trim()) throw new Error(`invalid_identity_decision:${key}`);
  if (Number.isNaN(Date.parse(item.reviewed_at))) throw new Error('invalid_identity_decision:reviewed_at');
  return item;
}

function resolveIdentity(rawStyleId, rawStyleVersion, fingerprint, decisions) {
  const styleId = typeof rawStyleId === 'string' && rawStyleId.trim() ? rawStyleId.trim() : null;
  const styleVersion = typeof rawStyleVersion === 'string' && rawStyleVersion.trim() ? rawStyleVersion.trim() : null;
  const decision = identityDecisionFor(fingerprint, decisions);
  if (styleId && styleVersion) {
    if (decision && (decision.style_id.trim() !== styleId || decision.style_version.trim() !== styleVersion)) throw new Error('identity_decision_conflicts_with_source');
    return { raw_style_id: styleId, raw_style_version: styleVersion, style_id: styleId, style_version: styleVersion, resolution: 'explicit_source', decision_id: null };
  }
  if (decision) return { raw_style_id: styleId, raw_style_version: styleVersion, style_id: decision.style_id.trim(), style_version: decision.style_version.trim(), resolution: 'fingerprint_td_confirmation', decision_id: decision.decision_id };
  return { raw_style_id: styleId, raw_style_version: styleVersion, style_id: null, style_version: null, resolution: 'pending_td_confirmation', decision_id: null };
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(value || ''));
  if (!match) return null;
  try {
    return { mediaType: match[1] || 'application/octet-stream', bytes: match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8') };
  } catch { return null; }
}

function pomConcept(pomKey) {
  const number = Number(pomKey);
  return Number.isInteger(number) && number >= 1 && number <= 16 ? registry().get(number) || null : null;
}

export function importSavedProject(file, identityDecisions = null) {
  const bytes = readFileSync(file); const fingerprint = fp(bytes); let project;
  try { project = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid_project_json'); }
  if (project?.format !== 'bra-sketch-project') throw new Error('unsupported_project_format');
  if (project?.version !== 1) throw new Error('unsupported_project_version');
  if (!project.state || typeof project.state !== 'object') throw new Error('invalid_project_state');
  const state = project.state; const issues = new Set();
  const identity = resolveIdentity(state.styleId, state.styleVersion, fingerprint, identityDecisions);
  if (!identity.style_id || !identity.style_version) issues.add('identity_requires_td_confirmation');

  const imageArtifacts = [];
  for (const [index, image] of (Array.isArray(state.images) ? state.images : []).entries()) {
    const decoded = decodeDataUrl(image?.dataURL);
    if (!decoded) { issues.add('source_image_data_missing_or_invalid'); continue; }
    imageArtifacts.push({ image_id: `source-image-${index + 1}`, role: 'source_sketch', fingerprint: fp(decoded.bytes), media_type: decoded.mediaType, source_image_id: image.id ?? null });
  }
  imageArtifacts.sort((a, b) => a.image_id.localeCompare(b.image_id));

  const custom = new Map((Array.isArray(state.customPoms) ? state.customPoms : []).map(item => [String(item.pom), item]));
  const pomValues = [];
  for (const key of Object.keys(state.pomSpecs || {}).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))) {
    const spec = state.pomSpecs[key]; if (!spec || typeof spec !== 'object') continue;
    const concept = pomConcept(key); const customPom = custom.get(key); const tolText = spec.tol == null ? null : String(spec.tol); const tol = parseTolerance(tolText);
    if (tolText && tol == null) issues.add('unparseable_tolerance');
    for (const [field, sizeCode] of [['sizeL', 'L'], ['sizeL2', 'L2']]) {
      if (spec[field] == null || String(spec[field]).trim() === '') continue;
      const sourceText = String(spec[field]); const value = parseMeasurement(sourceText);
      if (value == null) issues.add('nonnumeric_measurement_value');
      pomValues.push({ pom_key: key, concept_id: concept?.concept_id || null, pom_number: concept?.pom_number || null, size_code: sizeCode, value_in: value, source_text: sourceText, tolerance_text: tolText, tolerance_value_in: tol, description_en: spec.en ?? customPom?.en ?? concept?.canonical_name_en ?? null, description_zh: spec.zh ?? customPom?.zh ?? concept?.canonical_name_zh ?? null, grade_rules: state.gradeRules && typeof state.gradeRules === 'object' ? clone({ steps: state.gradeRules.steps?.[key] ?? null, alpha: state.gradeRules.alpha?.[key] ?? null, depth: state.gradeRules.depth?.[key] ?? null, depthOffset: state.gradeRules.depthOffsets?.[key] ?? null }) : null });
    }
  }

  const geometry = (Array.isArray(state.annotations) ? state.annotations : []).map(annotation => ({
    annotation_id: annotation?.id ?? null,
    pom_number: annotation?.pomNumber != null ? String(annotation.pomNumber) : annotation?.seq != null ? String(annotation.seq) : annotation?.text != null ? String(annotation.text) : null,
    type: annotation?.type ?? null,
    view: annotation?.viewRole ?? null,
    source_image_id: annotation?.sourceImageId ?? null,
    start: annotation?.start && typeof annotation.start === 'object' ? clone(annotation.start) : null,
    end: annotation?.end && typeof annotation.end === 'object' ? clone(annotation.end) : null,
    control1: annotation?.control1 && typeof annotation.control1 === 'object' ? clone(annotation.control1) : null,
    control2: annotation?.control2 && typeof annotation.control2 === 'object' ? clone(annotation.control2) : null,
    proposed_start_landmark: annotation?.proposedStartLandmark ?? null,
    proposed_end_landmark: annotation?.proposedEndLandmark ?? null,
    template_version: annotation?.templateVersion ?? null,
    rule_version: annotation?.ruleVersion ?? null,
    td_edited: annotation?.tdEdited === true,
    td_approved: annotation?.tdApproved === true,
    raw_annotation: clone(annotation || {}),
  })).sort((a, b) => String(a.annotation_id ?? '').localeCompare(String(b.annotation_id ?? '')));

  const uniqueVersion = key => { const values = [...new Set(geometry.map(item => item[key]).filter(Boolean))]; return values.length === 1 ? values[0] : null; };
  const templateVersion = uniqueVersion('template_version'); const ruleVersion = uniqueVersion('rule_version');
  if (!templateVersion || !ruleVersion) issues.add('contract_versions_incomplete_or_mixed');
  issues.add('anchor_version_not_recorded_in_project'); issues.add('detector_version_not_recorded_in_project');
  return {
    schema_version: 'project-intake.v1', candidate_id: `project-sha256-${sha(bytes)}`, status: 'pending',
    source: { type: 'saved-project-json', file_name: path.basename(file), fingerprint, format: project.format, version: project.version, saved_at: typeof project.savedAt === 'string' ? project.savedAt : null },
    identity,
    contract_versions: { project: 1, template: templateVersion, rule: ruleVersion, anchor: null, detector: null },
    image_artifacts: imageArtifacts, pom_values: pomValues, geometry, raw_snapshot: project, issues: [...issues].sort(),
  };
}

function candidateSource(candidate) {
  return { candidate_id: candidate.candidate_id, type: candidate.source.type, fingerprint: candidate.source.fingerprint, file_name: candidate.source.file_name, reason: null };
}

function candidateIdentity(candidate, decisions) {
  if (candidate.identity?.style_id && candidate.identity?.style_version) return candidate.identity;
  return resolveIdentity(candidate.identity?.raw_style_id, candidate.identity?.raw_style_version, candidate.source.fingerprint, decisions);
}

function candidateObservations(candidate) {
  if (Array.isArray(candidate.pom_values)) return candidate.pom_values.map(item => ({ key: `${item.concept_id || `pom:${item.pom_key}`}|${item.size_code || ''}`, value_in: item.value_in }));
  if (Array.isArray(candidate.records)) return candidate.records.map(item => ({ key: `${item.concept_id || `pom:${item.raw_pom_number || ''}`}|${item.size_code || ''}`, value_in: item.value_in }));
  return [];
}

export function linkEvidenceBundles(candidates, identityDecisions = null) {
  const unique = [...new Map(candidates.map(item => [item?.source?.fingerprint, item])).values()]
    .filter(item => item?.source?.fingerprint)
    .sort((a, b) => a.source.fingerprint.localeCompare(b.source.fingerprint));
  const grouped = new Map(); const unresolved = [];
  for (const candidate of unique) {
    const identity = candidateIdentity(candidate, identityDecisions); const source = candidateSource(candidate);
    if (!identity.style_id || !identity.style_version) { source.reason = 'identity_requires_td_confirmation'; unresolved.push(source); continue; }
    const key = `${identity.style_id}\0${identity.style_version}`;
    if (!grouped.has(key)) grouped.set(key, { identity, candidates: [] });
    grouped.get(key).candidates.push(candidate);
  }
  const bundles = [...grouped.values()].map(group => {
    const sourceFingerprints = group.candidates.map(item => item.source.fingerprint).sort(); const observations = new Map();
    for (const candidate of group.candidates) for (const observation of candidateObservations(candidate)) {
      if (observation.value_in == null) continue;
      if (!observations.has(observation.key)) observations.set(observation.key, []);
      observations.get(observation.key).push({ candidate_id: candidate.candidate_id, source_fingerprint: candidate.source.fingerprint, value_in: observation.value_in });
    }
    const conflicts = [...observations.entries()].filter(([, items]) => new Set(items.map(item => item.value_in)).size > 1)
      .map(([key, items]) => ({ key, reason: 'different_values_same_style_version_pom_size', observations: items.sort((a, b) => a.source_fingerprint.localeCompare(b.source_fingerprint)) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const images = group.candidates.flatMap(item => item.image_artifacts || []).map(item => clone(item)).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.image_id.localeCompare(b.image_id));
    return { bundle_id: `bundle-sha256-${sha(Buffer.from(`${group.identity.style_id}\0${group.identity.style_version}`, 'utf8'))}`, style_id: group.identity.style_id, style_version: group.identity.style_version, status: 'pending', approval_blocked: true, source_fingerprints: sourceFingerprints, sources: group.candidates.map(candidateSource).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)), image_artifacts: images, conflicts };
  }).sort((a, b) => a.style_id.localeCompare(b.style_id) || a.style_version.localeCompare(b.style_version));
  const blockingConflictCount = bundles.reduce((count, bundle) => count + bundle.conflicts.length, 0);
  return { schema_version: 'evidence-bundles.v1', status: 'pending', bundles, unresolved_sources: unresolved.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)), summary: { source_count: unique.length, bundle_count: bundles.length, unresolved_source_count: unresolved.length, blocking_conflict_count: blockingConflictCount, approval_ready_count: 0 } };
}

function reviewedMeasurementCorrections() {
  const dir = path.join(APP, 'library/corrections/reviewed');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
    try { return JSON.parse(readFileSync(path.join(dir, name), 'utf8')); }
    catch (_) { return null; }
  }).filter(Boolean);
}

export function conflictReport(candidate, corrections = []) {
  const groups = new Map();
  for (const record of candidate.records.filter(record => record.mapping_status !== 'excluded_out_of_scope')) {
    // Source POM numbers are not globally stable: legacy workbooks can reuse
    // one raw number for different measurement terms. A duplicate conflict is
    // therefore defined by canonical concept when mapped, or by normalized raw
    // term while unresolved — never by the source row number alone.
    const measurementIdentity = record.concept_id
      ? `concept:${record.concept_id}`
      : `term:${norm(record.raw_term) || `raw-pom:${record.raw_pom_number || ''}`}`;
    const key = [record.raw_style_id, record.raw_style_version, measurementIdentity, record.size_code].map(v => v ?? '').join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const conflicts = [];
  for (const [key, records] of groups) {
    const observations = [...new Map(records.map(r => [`${r.value_in}|${r.raw_source_file}`, { value_in: r.value_in, raw_source_file: r.raw_source_file, source_row: r.source_row }])).values()];
    if (new Set(records.map(r => r.value_in)).size <= 1) continue;
    const first = records[0];
    const resolved = corrections.some(correction =>
      correction.category === 'measurement'
      && correction.td_status === 'accepted'
      && ['reviewed', 'promoted'].includes(correction.status)
      && correction.style_id === first.raw_style_id
      && correction.style_version === first.raw_style_version
      && correction.concept_id === first.concept_id
      && correction.pom_number === first.pom_number
      && correction.after?.size_code === first.size_code
      && records.some(record => record.value_in === correction.after?.value_in));
    if (!resolved) conflicts.push({ key, observations: observations.sort((a, b) => (a.raw_source_file || '').localeCompare(b.raw_source_file || '') || a.source_row - b.source_row) });
  }
  conflicts.sort((a, b) => a.key.localeCompare(b.key));
  return { report_version: 'pending-intake-conflicts.v1', candidate_id: candidate.candidate_id, conflict_count: conflicts.length, conflicts };
}

function similarity(a, b) {
  const aa = norm(a); const bb = norm(b); if (!aa || !bb) return 0; if (aa === bb) return 1;
  const ta = new Set(aa.split(' ')); const tb = new Set(bb.split(' '));
  const common = [...ta].filter(t => tb.has(t)).length;
  const tokenScore = common / new Set([...ta, ...tb]).size;
  const compactA = aa.replace(/ /g, ''); const compactB = bb.replace(/ /g, '');
  const grams = s => { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
  const ga = grams(compactA); const gb = grams(compactB); const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let hits = 0; for (const g of gb) if ((counts.get(g) || 0) > 0) { hits++; counts.set(g, counts.get(g) - 1); }
  const dice = ga.length + gb.length ? (2 * hits) / (ga.length + gb.length) : 0;
  return Math.max(tokenScore, dice);
}

function candidateCompatible(raw, candidate) {
  const rawTokens = new Set(norm(raw).split(' ').filter(Boolean)); const candidateTokens = new Set(norm(candidate).split(' ').filter(Boolean));
  const dimensions = ['width', 'height', 'length', 'distance'];
  const presentDimensions = tokens => dimensions.filter(d => [...tokens].some(t => t === d || t === `${d}s`));
  const rawDimensions = presentDimensions(rawTokens); const candidateDimensions = presentDimensions(candidateTokens);
  if (rawDimensions.length && candidateDimensions.length && !rawDimensions.some(t => candidateDimensions.includes(t))) return false;
  const components = ['band', 'chest', 'cup', 'strap', 'side', 'back', 'front', 'cradle'];
  const rawComponents = components.filter(t => rawTokens.has(t)); const candidateComponents = components.filter(t => candidateTokens.has(t));
  if (rawComponents.length && candidateComponents.length && !rawComponents.some(t => candidateTokens.has(t))) return false;
  const constructionSpecific = ['hook', 'eye', 'foam', 'mesh', 'fabric'];
  if (!rawComponents.length && constructionSpecific.some(t => rawTokens.has(t) && !candidateTokens.has(t))) return false;
  return true;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function htmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function buildTdReview(candidate, conflicts = conflictReport(candidate)) {
  const concepts = [...registry().values()]; const groups = new Map();
  for (const record of candidate.records.filter(r => r.mapping_status === 'pending_term_mapping')) {
    const key = norm(record.raw_term) || '(blank)';
    if (!groups.has(key)) groups.set(key, { records: [], variants: new Set(), styles: new Set(), sources: new Set(), pomNumbers: new Set(), warnings: new Set() });
    const group = groups.get(key); group.records.push(record); group.variants.add(record.raw_term || '(blank)');
    if (record.raw_style_id) group.styles.add(record.raw_style_id); if (record.raw_source_file) group.sources.add(record.raw_source_file); if (record.raw_pom_number) group.pomNumbers.add(record.raw_pom_number);
    if (record.tolerance_text && record.tolerance_value_in == null) group.warnings.add('unparseable_tolerance');
    if (record.value_in == null && record.source_text) group.warnings.add('unparseable_value');
  }
  const unresolved = [...groups.entries()].map(([normalizedTerm, group]) => {
    const candidates = concepts.map(concept => {
      const labels = [concept.canonical_name_en, ...(concept.aliases_approved || [])];
      const compatibleLabels = labels.filter(label => candidateCompatible(normalizedTerm, label));
      const textScore = compatibleLabels.length ? Math.max(...compatibleLabels.map(label => similarity(normalizedTerm, label))) : 0;
      const numberHint = group.pomNumbers.has(String(concept.pom_number)) ? 0.12 : 0;
      return { concept_id: concept.concept_id, pom_number: concept.pom_number, label: concept.canonical_name_en, score: Math.min(1, textScore + numberHint) };
    }).filter(item => item.score >= 0.25).sort((a, b) => b.score - a.score || a.pom_number - b.pom_number).slice(0, 3).map(item => ({ ...item, score: Math.round(item.score * 1000) / 1000 }));
    return {
      normalized_term: normalizedTerm,
      variants: [...group.variants].sort(),
      occurrence_count: group.records.length,
      style_count: group.styles.size,
      source_count: group.sources.size,
      raw_pom_numbers: [...group.pomNumbers].sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b))),
      example_styles: [...group.styles].sort().slice(0, 8),
      candidates,
      warnings: [...group.warnings].sort(),
    };
  }).sort((a, b) => b.occurrence_count - a.occurrence_count || a.normalized_term.localeCompare(b.normalized_term));

  const headers = ['priority','type','raw_term','occurrences','style_count','source_count','raw_pom_numbers','variants','example_styles','candidate_1','candidate_1_score','candidate_2','candidate_2_score','candidate_3','candidate_3_score','conflict_key','conflict_observations','warnings','td_action','approved_concept_id','td_notes'];
  const rows = [];
  for (const conflict of conflicts.conflicts) rows.push({ priority: 'BLOCKER', type: 'conflict', conflict_key: conflict.key, conflict_observations: conflict.observations.map(o => `${o.value_in} @ ${o.raw_source_file}:${o.source_row}`).join(' | '), warnings: 'different_values_same_raw_identity' });
  unresolved.forEach((group, index) => rows.push({
    priority: index < 20 ? 'HIGH' : group.occurrence_count >= 5 ? 'MEDIUM' : 'LOW', type: 'unresolved_term', raw_term: group.normalized_term, occurrences: group.occurrence_count, style_count: group.style_count, source_count: group.source_count,
    raw_pom_numbers: group.raw_pom_numbers.join(' | '), variants: group.variants.join(' | '), example_styles: group.example_styles.join(' | '),
    candidate_1: group.candidates[0] ? `${group.candidates[0].concept_id} (POM ${group.candidates[0].pom_number})` : '', candidate_1_score: group.candidates[0]?.score ?? '',
    candidate_2: group.candidates[1] ? `${group.candidates[1].concept_id} (POM ${group.candidates[1].pom_number})` : '', candidate_2_score: group.candidates[1]?.score ?? '',
    candidate_3: group.candidates[2] ? `${group.candidates[2].concept_id} (POM ${group.candidates[2].pom_number})` : '', candidate_3_score: group.candidates[2]?.score ?? '', warnings: group.warnings.join(' | '),
  }));
  const csv = `${headers.join(',')}\n${rows.map(row => headers.map(h => csvCell(row[h] ?? '')).join(',')).join('\n')}\n`;
  const conflictRows = conflicts.conflicts.map(c => `<tr><td>${htmlEscape(c.key)}</td><td>${htmlEscape(c.observations.map(o => `${o.value_in} @ ${o.raw_source_file}:${o.source_row}`).join(' | '))}</td><td><strong>TD resolution required</strong></td></tr>`).join('');
  const unresolvedRows = unresolved.map((g, i) => `<tr><td>${i + 1}</td><td><strong>${htmlEscape(g.variants[0])}</strong>${g.variants.length > 1 ? `<br><small>${htmlEscape(g.variants.slice(1).join(' | '))}</small>` : ''}</td><td>${g.occurrence_count}</td><td>${g.style_count}</td><td>${htmlEscape(g.raw_pom_numbers.join(', '))}</td><td>${g.candidates.map(c => `${htmlEscape(c.concept_id)} (POM ${c.pom_number}, ${Math.round(c.score * 100)}%)`).join('<br>') || 'No candidate'}</td><td>${htmlEscape(g.warnings.join(', '))}</td></tr>`).join('');
  const excludedCount = candidate.records.filter(record => record.mapping_status === 'excluded_out_of_scope').length;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>TD Measurement Library Review</title><style>body{font:14px system-ui;margin:32px;color:#172033}h1{margin-bottom:4px}.note{color:#5b6475}.cards{display:flex;gap:12px;margin:22px 0}.card{padding:14px 18px;border:1px solid #d9dee8;border-radius:10px;background:#f8fafc}.card b{font-size:24px;display:block}table{border-collapse:collapse;width:100%;margin:12px 0 30px}th,td{border:1px solid #d9dee8;padding:8px;vertical-align:top;text-align:left}th{background:#eef2f7;position:sticky;top:0}tr:nth-child(even){background:#fafbfc}.blocker{color:#a21b1b}small{color:#687386}</style></head><body><h1>TD Measurement Library Review</h1><p class="note">Read-only review output. Candidate concepts are suggestions for TD review, never automatic mappings or approvals.</p><div class="cards"><div class="card"><b>${candidate.records.length}</b>pending observations</div><div class="card"><b>${unresolved.reduce((n,g)=>n+g.occurrence_count,0)}</b>unresolved observations</div><div class="card"><b>${excludedCount}</b>out-of-scope observations</div><div class="card"><b class="blocker">${conflicts.conflict_count}</b>conflicts</div></div><h2 class="blocker">Conflicts — review first</h2><table><thead><tr><th>Raw identity</th><th>Observations</th><th>Action</th></tr></thead><tbody>${conflictRows || '<tr><td colspan="3">No conflicts</td></tr>'}</tbody></table><h2>Unresolved terms</h2><table><thead><tr><th>#</th><th>Raw term / variants</th><th>Rows</th><th>Styles</th><th>Raw POM</th><th>Candidate concepts</th><th>Warnings</th></tr></thead><tbody>${unresolvedRows}</tbody></table></body></html>`;
  return { model: { report_version: 'td-review.v1', candidate_id: candidate.candidate_id, summary: { pending_observations: candidate.records.length, unresolved_observations: unresolved.reduce((n,g)=>n+g.occurrence_count,0), excluded_out_of_scope_observations: excludedCount, grouped_terms: unresolved.length, conflicts: conflicts.conflict_count }, conflicts: conflicts.conflicts, unresolved }, csv, html };
}

function stable(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function argsMap(args) { const out = {}; for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) (out[args[i].slice(2)] ||= []).push(args[++i]); return out; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2); const args = argsMap(rest); let result;
  if (command === 'inventory') result = inventoryRoots((args.root || []).map((v, i) => { const at = v.indexOf('='); return { id: at > 0 ? v.slice(0, at) : `root-${i + 1}`, path: at > 0 ? v.slice(at + 1) : v }; }));
  else if (command === 'import-xlsx') result = importCurrentWorkbook(args.input?.[0]);
  else if (command === 'import-legacy-size-l') result = importLegacySizeLCsv(args.input?.[0]);
  else if (command === 'import-project') result = importSavedProject(args.input?.[0], args['identity-decisions']?.[0] ? JSON.parse(readFileSync(args['identity-decisions'][0], 'utf8')) : null);
  else if (command === 'link-evidence') result = linkEvidenceBundles((args.input || []).map(file => JSON.parse(readFileSync(file, 'utf8'))), args['identity-decisions']?.[0] ? JSON.parse(readFileSync(args['identity-decisions'][0], 'utf8')) : null);
  else if (command === 'report-conflicts') result = conflictReport(JSON.parse(readFileSync(args.input?.[0], 'utf8')), reviewedMeasurementCorrections());
  else if (command === 'report-td-review') {
    const candidate = JSON.parse(readFileSync(args.input?.[0], 'utf8')); const review = buildTdReview(candidate, conflictReport(candidate, reviewedMeasurementCorrections()));
    if (args.csv?.[0]) writeFileSync(args.csv[0], review.csv); if (args.html?.[0]) writeFileSync(args.html[0], review.html); if (args.output?.[0]) writeFileSync(args.output[0], stable(review.model));
    if (!args.csv?.[0] && !args.html?.[0] && !args.output?.[0]) process.stdout.write(stable(review.model));
    process.exit(0);
  }
  else throw new Error('usage: library-intake.mjs inventory --root id=path [--root id=path] --output file | import-xlsx --input file --output file | import-legacy-size-l --input file --output file | import-project --input file [--identity-decisions file] --output file | link-evidence --input candidate.json [--input candidate.json] [--identity-decisions file] --output file | report-conflicts --input pending.json --output report.json | report-td-review --input pending.json --csv report.csv --html report.html --output report.json');
  const text = stable(result); if (args.output?.[0]) writeFileSync(args.output[0], text); else process.stdout.write(text);
}
