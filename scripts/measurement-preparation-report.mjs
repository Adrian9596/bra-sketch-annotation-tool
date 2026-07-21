#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const checkOnly = process.argv.includes('--check');

const relative = {
  suggestions: 'auto_mode_rules/sizeL-suggestions.json',
  template: 'auto_mode_rules/pom-template.json',
  manifest: 'library/manifest.json',
  pending: 'library/intake/exports/measurements-size-l.pending.json',
  conflicts: 'library/reports/conflicts/measurements-size-l.conflicts.json',
  inventory: 'library/reports/intake/source-inventory.v1.json',
  baseline: 'library/reports/evaluation/tier0-population-baseline.v1.json',
  matrix: 'library/reports/coverage/measurement-evidence-matrix.v1.json',
  viability: 'library/reports/coverage/construction-library-viability.v1.json',
};

function absolute(rel) {
  return path.join(appDir, rel);
}

function readJson(rel) {
  return JSON.parse(readFileSync(absolute(rel), 'utf8'));
}

function fingerprint(rel) {
  return `sha256:${createHash('sha256').update(readFileSync(absolute(rel))).digest('hex')}`;
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function writeOrCheck(rel, value) {
  const next = stableJson(value);
  const target = absolute(rel);
  if (checkOnly) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== next) {
      throw new Error(`${rel} is stale; run npm run measurement-prep-report`);
    }
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, next);
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = String(keyFn(item));
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })));
}

function styleKey(record) {
  return `${record.raw_style_id || 'missing'}|${record.raw_style_version || 'missing'}`;
}

function evidenceStrategy(pom) {
  if (pom >= 1 && pom <= 4) return {
    numeric_strategy: 'library_prior',
    confidence_cap: 'medium',
    td_decision_required: [],
  };
  if (pom >= 5 && pom <= 10) return {
    numeric_strategy: 'hybrid_candidate_front',
    confidence_cap: null,
    td_decision_required: ['front_calibration_compatibility', 'per_pom_agreement_threshold'],
  };
  if (pom >= 11 && pom <= 13) return {
    numeric_strategy: 'hybrid_candidate_back',
    confidence_cap: null,
    td_decision_required: ['back_calibration_compatibility', 'per_pom_agreement_threshold'],
  };
  if (pom === 14) return {
    numeric_strategy: 'library_prior',
    confidence_cap: null,
    td_decision_required: ['library_prior_confidence_cap'],
  };
  return {
    numeric_strategy: 'no_data',
    confidence_cap: 'none',
    td_decision_required: [],
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`report invariant failed: ${message}`);
}

function validateReports({ baseline, matrix, viability }) {
  assert(baseline.poms.length === 18, 'Tier-0 baseline must contain exactly 18 POMs');
  assert(matrix.poms.length === 18, 'evidence matrix must contain exactly 18 POMs');
  for (const pom of matrix.poms.filter((row) => row.pom >= 1 && row.pom <= 4)) {
    assert(pom.numeric_strategy === 'library_prior', `POM ${pom.pom} must use library_prior`);
    assert(pom.confidence_cap === 'medium', `POM ${pom.pom} must be capped at medium`);
  }
  const pom14 = matrix.poms.find((row) => row.pom === 14);
  assert(pom14?.numeric_strategy === 'library_prior', 'POM 14 numeric value must use library_prior');
  assert(pom14?.placement_evidence === 'detected_endpoints_with_constructed_bezier_review_line',
    'POM 14 placement evidence must remain separate from numeric value evidence');
  for (const pom of matrix.poms.filter((row) => row.pom === 15 || row.pom === 16 || row.pom === 17 || row.pom === 18)) {
    assert(pom.phase_1_scope === 'out_of_scope_no_data', `POM ${pom.pom} must be out-of-scope no_data`);
    assert(pom.numeric_strategy === 'no_data', `POM ${pom.pom} must not receive a numeric strategy`);
  }
  const eligible = viability.pending_intake.style_versions_meeting_minimum_10_poms;
  const ready = viability.gate.construction_filtered_peer_estimator_ready;
  assert(!(eligible === 0 && ready), 'peer estimator cannot be ready with zero eligible style-versions');
  assert(viability.pending_intake.mapped_contract_records + viability.pending_intake.unresolved_term_records
    + viability.pending_intake.excluded_out_of_scope_records === viability.pending_intake.records,
  'mapped, unresolved, and excluded pending counts must reconcile');
}

function buildReports() {
  const suggestions = readJson(relative.suggestions);
  const template = readJson(relative.template);
  const manifest = readJson(relative.manifest);
  const pending = readJson(relative.pending);
  const conflicts = readJson(relative.conflicts);
  const inventory = readJson(relative.inventory);

  const sources = {
    [relative.suggestions]: fingerprint(relative.suggestions),
    [relative.template]: fingerprint(relative.template),
    [relative.manifest]: fingerprint(relative.manifest),
    [relative.pending]: fingerprint(relative.pending),
    [relative.conflicts]: fingerprint(relative.conflicts),
    [relative.inventory]: fingerprint(relative.inventory),
  };

  const poms = template.rows.map((row) => {
    const id = Number(row.id);
    const suggestion = suggestions.poms[String(id)];
    const strategy = evidenceStrategy(id);
    return {
      pom: id,
      concept: suggestion?.concept ?? null,
      name: row.name,
      view: row.view,
      placement_view_role: row.placementViewRole || row.view,
      required_anchors: row.requiredAnchors || [],
      placement_confidence_contract: row.expected_confidence_tier,
      phase_1_scope: id <= 14 ? 'in_scope' : 'out_of_scope_no_data',
      placement_evidence: id === 14
        ? 'detected_endpoints_with_constructed_bezier_review_line'
        : 'detected_anchor_geometry',
      numeric_strategy: strategy.numeric_strategy,
      library_prior_available: Boolean(suggestion && suggestion.n > 0 && suggestion.median != null),
      library_prior_confidence: suggestion?.confidence || 'very_low',
      confidence_cap: strategy.confidence_cap,
      td_decision_required: strategy.td_decision_required,
      notes: id === 14
        ? ['Placement evidence is useful; the constructed front-to-back Bezier length is not numeric measurement evidence.']
        : [],
    };
  });

  const baseline = {
    report_version: 'tier0-population-baseline.v1',
    baseline_kind: 'population_statistics_not_accuracy_ground_truth',
    generator: 'scripts/measurement-preparation-report.mjs',
    source_fingerprints: sources,
    suggestions_version: suggestions.suggestions_version,
    unit: suggestions.unit,
    corpus: suggestions.provenance,
    scope: {
      phase_1_numeric_poms: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      out_of_scope_no_data_poms: [15, 16, 17, 18],
    },
    limitations: [
      'This report snapshots population priors; it does not claim per-POM accuracy.',
      'Within-TOL and catastrophic-error metrics require TD-approved measurement ground truth.',
      'Runtime Tier-0 provenance is separate from the governed library manifest approval counts.',
    ],
    poms: template.rows.map((row) => ({
      pom: Number(row.id),
      concept: suggestions.poms[row.id]?.concept ?? null,
      median: suggestions.poms[row.id]?.median ?? null,
      min: suggestions.poms[row.id]?.min ?? null,
      max: suggestions.poms[row.id]?.max ?? null,
      tol: suggestions.poms[row.id]?.tol ?? null,
      tol_type: suggestions.poms[row.id]?.tolType ?? null,
      sample_count: suggestions.poms[row.id]?.n ?? 0,
      confidence: suggestions.poms[row.id]?.confidence ?? 'very_low',
      source: suggestions.poms[row.id]?.source ?? 'none',
    })),
  };

  const mapped = pending.records.filter((record) => record.mapping_status === 'mapped_contract');
  const unresolved = pending.records.filter((record) => record.mapping_status === 'pending_term_mapping');
  const excluded = pending.records.filter((record) => record.mapping_status === 'excluded_out_of_scope');
  const rawStyleVersions = new Set(pending.records.map(styleKey));
  const mappedByStyle = new Map();
  for (const record of mapped) {
    const key = styleKey(record);
    if (!mappedByStyle.has(key)) mappedByStyle.set(key, new Set());
    if (record.pom_number != null) mappedByStyle.get(key).add(record.pom_number);
  }
  const coverageCounts = [...mappedByStyle.values()].map((pomsForStyle) => pomsForStyle.size);
  const eligibleStyleVersions = [...mappedByStyle.entries()]
    .filter(([, pomsForStyle]) => pomsForStyle.size >= 10)
    .map(([key]) => key)
    .sort();
  const inventoryClassifications = countBy(inventory.files, (file) => file.classification);

  const viabilityBlockers = [];
  if (!(manifest.counts?.styles?.approved > 0) || !(manifest.counts?.pom_values?.approved > 0)) {
    viabilityBlockers.push('No governed approved styles or POM value sets are registered in the library manifest.');
  }
  if (eligibleStyleVersions.length === 0) {
    viabilityBlockers.push('No pending style-version currently reaches 10 distinct mapped canonical POMs.');
  }
  viabilityBlockers.push('Construction, closure, and independent-family metadata are absent from the pending intake contract.');
  if (conflicts.conflict_count > 0) {
    viabilityBlockers.push(`${conflicts.conflict_count} duplicate measurement conflicts remain unresolved.`);
  }

  const viability = {
    report_version: 'construction-library-viability.v1',
    generator: 'scripts/measurement-preparation-report.mjs',
    source_fingerprints: sources,
    governed_manifest_counts: manifest.counts,
    runtime_tier0_legacy_corpus: {
      corpus_rows: suggestions.provenance.corpusRows,
      style_versions: suggestions.provenance.styleVersions,
      dropped_rows: suggestions.provenance.droppedRows,
      status: 'runtime_population_prior_not_governed_construction_peer_set',
    },
    pending_intake: {
      status: pending.status,
      records: pending.records.length,
      raw_style_versions: rawStyleVersions.size,
      mapped_contract_records: mapped.length,
      unresolved_term_records: unresolved.length,
      excluded_out_of_scope_records: excluded.length,
      mapped_canonical_poms: [...new Set(mapped.map((record) => record.pom_number).filter(Number.isInteger))].sort((a, b) => a - b),
      canonical_pom_coverage_distribution: countBy(coverageCounts, (count) => count),
      style_versions_meeting_minimum_10_poms: eligibleStyleVersions.length,
      unresolved_duplicate_conflicts: conflicts.conflict_count,
      construction_metadata_records: 0,
      closure_metadata_records: 0,
      independent_family_identity_records: 0,
    },
    source_inventory: {
      files: inventory.files.length,
      classifications: inventoryClassifications,
      parse_eligible: inventory.files.filter((file) => file.parse_eligible).length,
      duplicates: inventory.files.filter((file) => file.duplicate_of != null).length,
    },
    gate: {
      construction_filtered_peer_estimator_ready: viabilityBlockers.length === 0,
      blocking_reasons: viabilityBlockers,
    },
  };

  const matrix = {
    report_version: 'measurement-evidence-matrix.v1',
    generator: 'scripts/measurement-preparation-report.mjs',
    source_fingerprints: sources,
    agreed_rules: [
      'Phase 1 numeric scope is POM 1-14; POM 15-18 are no_data, not not_applicable.',
      'POM 1-4 use a Library Prior with confidence capped at medium.',
      'POM 14 placement evidence is separate from numeric value evidence; numeric value uses library or TD confirmation.',
    ],
    unresolved_td_decisions: [
      'Whether front and back require separate calibration contracts.',
      'Which POMs may calibrate which target POMs.',
      'Minimum independent peer and family counts.',
      'Per-POM pixel/library agreement thresholds.',
      'POM 14 Library Prior confidence cap.',
      'Construction applicability and release thresholds.',
    ],
    poms,
  };

  return { baseline, matrix, viability };
}

try {
  const reports = buildReports();
  validateReports(reports);
  writeOrCheck(relative.baseline, reports.baseline);
  writeOrCheck(relative.matrix, reports.matrix);
  writeOrCheck(relative.viability, reports.viability);
  console.log(`${checkOnly ? 'Verified' : 'Wrote'} deterministic measurement preparation reports.`);
} catch (error) {
  console.error(`measurement-preparation-report: ${error.message}`);
  process.exitCode = 1;
}
