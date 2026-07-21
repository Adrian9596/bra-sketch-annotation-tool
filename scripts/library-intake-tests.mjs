#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTdReview, conflictReport, importCurrentWorkbook, importLegacySizeLCsv, importSavedProject, inventoryRoots, linkEvidenceBundles } from './library-intake.mjs';
import { validateSchema } from './library-l0-tests.mjs';

let failures = 0;
function check(ok, label, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; }
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value); const n = Buffer.from(name); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, n); offset += local.length + n.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cell = (ref, value, formula = null) => `<c r="${ref}"${typeof value === 'string' ? ' t="inlineStr"' : ''}>${formula ? `<f>${esc(formula)}</f>` : ''}${typeof value === 'string' ? `<is><t>${esc(value)}</t></is>` : `<v>${value}</v>`}</c>`;
function workbook(sheetName = 'Measurement Spec', headers = ['POM','Description - English','Description - Chinese','TOL','L']) {
  const rows = [
    `<row r="1">${cell('A1', 'Measurement Spec')}</row>`,
    `<row r="2">${cell('A2', 'TestStyle - 11.Jul.26')}</row>`,
    `<row r="3">${headers.map((h, i) => cell(`${String.fromCharCode(65 + i)}3`, h)).join('')}</row>`,
    `<row r="4">${cell('A4', 5)}${cell('B4', 'Center front height')}${cell('C4', '前中高度')}${cell('D4', '± 1/8')}${cell('E4', 7.5, '7+0.5')}</row>`,
    `<row r="5">${cell('A5', 17)}${cell('B5', 'Wing seam length')}${cell('C5', '')}${cell('D5', '')}${cell('E5', 4)}</row>`,
  ].join('');
  return zipStore({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${sheetName}" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
    'xl/media/image1.png': Buffer.from('annotated-export-image'),
  });
}

function projectFixture(overrides = {}) {
  return {
    format: 'bra-sketch-project', version: 1, savedAt: '2026-07-11T00:00:00.000Z',
    state: {
      styleId: 'STYLE-001',
      images: [{ id: 'img-1', dataURL: `data:image/png;base64,${Buffer.from('original-sketch-image').toString('base64')}`, x: 0, y: 0, width: 100, height: 80 }],
      annotations: [{ id: 'ann-1', seq: 5, type: 'straight', viewRole: 'front_outer', sourceImageId: 'img-1', start: { x: 10, y: 5 }, end: { x: 10, y: 60 }, proposedStartLandmark: 'cf-top', proposedEndLandmark: 'cf-bottom', templateVersion: 'fixed16-2026-07-10', ruleVersion: 'offline-vision-rules-v3', tdEdited: true, tdApproved: true }],
      pomSpecs: { '5': { sizeL: '7 1/2', sizeL2: '7.75', tol: '1/8', en: 'Center front height', zh: '前中高度' } },
      gradeRules: { version: 2, steps: { '5': { step: 0.25 } }, alpha: {}, depth: {}, depthOffsets: {} },
      customPoms: [],
    },
    ...overrides,
  };
}

const dir = mkdtempSync(path.join(tmpdir(), 'library-intake-'));
try {
  const good = path.join(dir, 'good.xlsx'); const duplicate = path.join(dir, 'good-copy.xlsx'); const legacy = path.join(dir, 'legacy.xlsx');
  writeFileSync(good, workbook()); writeFileSync(duplicate, workbook()); writeFileSync(legacy, workbook('MEASUREMENT SPEC ', ['POM','Description','Tolerance','L']));
  const a = inventoryRoots([{ id: 'fixture', path: dir }]); const b = inventoryRoots([{ id: 'fixture', path: dir }]);
  check(JSON.stringify(a) === JSON.stringify(b), 'inventory is deterministic');
  check(a.files.filter(f => f.underlying_classification === 'eligible_current_export').length === 2, 'exact current exports recognized');
  check(a.files.some(f => f.classification === 'duplicate'), 'byte-identical workbook is deduplicated by SHA-256');
  check(a.files.some(f => f.underlying_classification === 'legacy_measurement_candidate' && !f.parse_eligible), 'near-match sheet is quarantined');
  const imported = importCurrentWorkbook(good); const importedAgain = importCurrentWorkbook(good);
  check(JSON.stringify(imported) === JSON.stringify(importedAgain), 'pending workbook output is byte-deterministic');
  check(imported.status === 'pending' && imported.identity.resolution === 'pending_td_confirmation', 'style identity is not fabricated or approved');
  check(imported.records.find(r => r.raw_pom_number === '5')?.concept_id === 'center_front_height', 'core POM maps only under exact current contract');
  check(imported.records.find(r => r.raw_pom_number === '17')?.concept_id === null, 'custom POM 17 is not confused with reserved library POM 17');
  check(imported.records.find(r => r.raw_pom_number === '5')?.source_formula === '7+0.5', 'formula and cached value provenance retained');
  check(imported.records.find(r => r.raw_pom_number === '5')?.tolerance_value_in === 0.125, 'inch fraction tolerance parsed');
  check(imported.image_artifacts.length === 1 && imported.image_artifacts[0].role === 'annotated_export', 'embedded workbook image is fingerprinted as a distinct export artifact');
  let rejected = false; try { importCurrentWorkbook(legacy); } catch { rejected = true; }
  check(rejected, 'legacy workbook cannot enter current-export importer');

  const csv = path.join(dir, 'legacy.csv');
  writeFileSync(csv, 'style_id,style_name,version,pom_no,description_raw,tol_raw,size_l_raw,size_l_in,pom_key_norm,old_concept,old_concept_label,source_file\nstyle-a,Style A,vA 1.0,5,Center front height,1/8,7.5,7.5,center front height,center_front_height,Center front height,old.xlsx\nstyle-a,Style A,vA 1.0,99,Unknown legacy term,00:00:00,3,3,unknown,x,x,old.xlsx\n');
  const legacyCandidate = importLegacySizeLCsv(csv);
  check(legacyCandidate.records.length === 2 && legacyCandidate.status === 'pending', 'legacy CSV becomes source-scoped pending records');
  check(legacyCandidate.records[0].raw_style_id === 'style-a' && legacyCandidate.records[0].raw_style_version === 'vA 1.0', 'raw style evidence is preserved without resolving identity');
  check(legacyCandidate.records[0].concept_id === 'center_front_height' && legacyCandidate.records[1].concept_id === null, 'legacy mapping uses exact canonical term and leaves unknown unresolved');
  check(legacyCandidate.issues.includes('unparseable_tolerance'), 'date-coerced tolerance is flagged');
  const conflict = conflictReport({ ...legacyCandidate, records: legacyCandidate.records.concat({ ...legacyCandidate.records[0], value_in: 8, raw_source_file: 'other.xlsx', source_row: 9 }) });
  check(conflict.conflict_count === 1, 'different values for the same style/concept/size are reported, not averaged');
  const resolvedConflict = conflictReport(
    { ...legacyCandidate, records: legacyCandidate.records.concat({ ...legacyCandidate.records[0], value_in: 8, raw_source_file: 'other.xlsx', source_row: 9 }) },
    [{ category: 'measurement', td_status: 'accepted', status: 'reviewed', style_id: legacyCandidate.records[0].raw_style_id, style_version: legacyCandidate.records[0].raw_style_version, concept_id: legacyCandidate.records[0].concept_id, pom_number: legacyCandidate.records[0].pom_number, after: { size_code: legacyCandidate.records[0].size_code, value_in: legacyCandidate.records[0].value_in } }],
  );
  check(resolvedConflict.conflict_count === 0, 'accepted reviewed correction resolves a matching measurement conflict without deleting source observations');
  const reviewInput = { ...legacyCandidate, records: legacyCandidate.records.concat({ ...legacyCandidate.records[1], raw_term: 'Unknown  legacy-term', raw_style_id: 'style-b', source_row: 4 }) };
  const review = buildTdReview(reviewInput, conflict);
  const reviewAgain = buildTdReview(reviewInput, conflict);
  check(JSON.stringify(review) === JSON.stringify(reviewAgain), 'TD review report is deterministic');
  check(review.model.summary.grouped_terms === 1 && review.model.unresolved[0].occurrence_count === 2, 'unresolved spelling variants group into one review decision');
  check(review.csv.split('\n')[1].includes('BLOCKER,conflict'), 'CSV puts conflicts before unresolved terms');
  check(review.csv.includes('td_action,approved_concept_id,td_notes'), 'CSV provides blank TD decision columns');
  check(review.html.includes('Candidate concepts are suggestions for TD review') && review.html.includes('Conflicts — review first'), 'HTML makes review-only semantics and priority visible');

  const projectFile = path.join(dir, 'project.json'); writeFileSync(projectFile, JSON.stringify(projectFixture()));
  const projectPending = importSavedProject(projectFile); const projectAgain = importSavedProject(projectFile);
  check(JSON.stringify(projectPending) === JSON.stringify(projectAgain), 'saved-project intake is byte-deterministic');
  check(projectPending.identity.resolution === 'pending_td_confirmation' && projectPending.issues.includes('identity_requires_td_confirmation'), 'project without explicit version stays identity-pending');
  check(projectPending.raw_snapshot.state.styleId === 'STYLE-001' && projectPending.source.fingerprint.startsWith('sha256:'), 'complete project snapshot and source fingerprint are preserved');
  check(projectPending.image_artifacts.length === 1 && projectPending.image_artifacts[0].role === 'source_sketch', 'original project image is fingerprinted as source sketch');
  check(projectPending.image_artifacts[0].fingerprint !== imported.image_artifacts[0].fingerprint, 'original sketch and annotated export image remain distinct');
  check(projectPending.pom_values.find(item => item.size_code === 'L')?.value_in === 7.5, 'mixed-fraction Size L value is extracted in inches');
  check(projectPending.geometry[0]?.proposed_start_landmark === 'cf-top' && projectPending.geometry[0]?.view === 'front_outer', 'pending geometry preserves view and landmark references');
  check(projectPending.contract_versions.anchor === null && projectPending.issues.includes('anchor_version_not_recorded_in_project'), 'missing contract provenance is explicit and not fabricated');

  const decision = { schema_version: 'identity-decisions.v1', decisions: [{ decision_id: 'identity-001', source_fingerprint: projectPending.source.fingerprint, style_id: 'STYLE-001', style_version: 'vA 1.0', reviewed_by: 'TD-1', reviewed_at: '2026-07-11T01:00:00.000Z' }] };
  const projectResolved = importSavedProject(projectFile, decision);
  check(projectResolved.identity.resolution === 'fingerprint_td_confirmation' && projectResolved.identity.style_version === 'vA 1.0', 'fingerprint-bound TD decision resolves incomplete identity');
  const projectSchema = JSON.parse(readFileSync(path.resolve('library/schemas/project-intake.schema.json'), 'utf8'));
  check(validateSchema(projectResolved, projectSchema).length === 0, 'generated project intake validates against its Draft 2020-12 schema');
  const changedProject = path.join(dir, 'project-changed.json'); writeFileSync(changedProject, JSON.stringify(projectFixture({ savedAt: '2026-07-11T00:00:01.000Z' })));
  check(importSavedProject(changedProject, decision).identity.resolution === 'pending_td_confirmation', 'changing source bytes invalidates the identity decision');

  const unknownVersion = path.join(dir, 'project-v2.json'); writeFileSync(unknownVersion, JSON.stringify(projectFixture({ version: 2 })));
  let versionRejected = false; try { importSavedProject(unknownVersion); } catch (error) { versionRejected = error.message === 'unsupported_project_version'; }
  check(versionRejected, 'unknown project version is quarantined fail-closed');
  const unknownFormat = path.join(dir, 'other.json'); writeFileSync(unknownFormat, JSON.stringify(projectFixture({ format: 'other-project' })));
  let formatRejected = false; try { importSavedProject(unknownFormat); } catch (error) { formatRejected = error.message === 'unsupported_project_format'; }
  check(formatRejected, 'unknown project format is quarantined fail-closed');

  const workbookDecision = { schema_version: 'identity-decisions.v1', decisions: [{ decision_id: 'identity-002', source_fingerprint: imported.source.fingerprint, style_id: 'STYLE-001', style_version: 'vA 1.0', reviewed_by: 'TD-1', reviewed_at: '2026-07-11T01:05:00.000Z' }] };
  const allDecisions = { schema_version: 'identity-decisions.v1', decisions: [...decision.decisions, ...workbookDecision.decisions] };
  const workbookConflict = { ...imported, records: imported.records.map(item => item.raw_pom_number === '5' && item.size_code === 'L' ? { ...item, value_in: 8 } : item) };
  const linked = linkEvidenceBundles([projectResolved, workbookConflict, projectResolved], allDecisions);
  const linkedAgain = linkEvidenceBundles([workbookConflict, projectResolved], allDecisions);
  check(JSON.stringify(linked) === JSON.stringify(linkedAgain), 'linked evidence output is order-independent and deterministic');
  check(linked.summary.source_count === 2 && linked.summary.bundle_count === 1, 'duplicate source fingerprints deduplicate before linking');
  check(linked.bundles[0].source_fingerprints.length === 2 && linked.bundles[0].image_artifacts.length === 2, 'project, workbook, and distinct image artifacts link through confirmed identity');
  check(linked.summary.blocking_conflict_count === 1 && linked.bundles[0].approval_blocked === true, 'different linked values remain a blocking conflict');
  check(linked.summary.approval_ready_count === 0 && linked.status === 'pending', 'linking never approves evidence');
  const bundleSchema = JSON.parse(readFileSync(path.resolve('library/schemas/evidence-bundles.schema.json'), 'utf8'));
  check(validateSchema(linked, bundleSchema).length === 0, 'generated evidence bundles validate against their Draft 2020-12 schema');
  const unresolvedLink = linkEvidenceBundles([projectPending]);
  check(unresolvedLink.bundles.length === 0 && unresolvedLink.unresolved_sources[0]?.reason === 'identity_requires_td_confirmation', 'incomplete identity cannot link automatically');

  const schema = JSON.parse(readFileSync(path.resolve('library/schemas/intake-candidate.schema.json'), 'utf8'));
  check(schema.properties.status.const === 'pending' && schema.properties.candidate_id.pattern.includes('sha256'), 'candidate schema enforces pending and content-derived identity');
} finally { rmSync(dir, { recursive: true, force: true }); }

if (failures) { console.error(`\n${failures} library intake assertion(s) failed.`); process.exit(1); }
console.log('\nAll library intake assertions passed.');
