#!/usr/bin/env node
// Regenerates auto_mode_rules/sizeL-suggestions.json from the approved Size-L
// measurement corpus in the sibling "Measurements 2" knowledge base.
//
// This is the Tier-0 "library value" source for the measurement-suggestion
// engine (docs/decisions/0009-measurement-suggestion-engine.md). Each of the
// 16 POMs gets a corpus-derived median (+ range, tolerance, sketch-reliability,
// sample count, confidence). POMs with no corpus rows (15 back-straps distance,
// 16 front apex) are emitted as "no data" so the panel shows a blank cell.
//
// PROVENANCE RULE (Measurements 2/KNOWLEDGE_BASE_PLAN.md): these statistics are
// DERIVED and must be regenerated from the corpus — never hand-edited. The
// runtime app never reads the corpus; it reads the checked-in JSON (and the
// copy inlined into app.js by scripts/build-app.mjs). The corpus is a
// build-time-only input, so the app stays fully offline.
//
// Usage:
//   node scripts/generate-sizeL-suggestions.mjs [--corpus "../Measurements 2"]
//   node scripts/generate-sizeL-suggestions.mjs --check   # verify, don't write
//
// Determinism: output is a pure function of the corpus (no timestamps), so
// scripts/suggestions-tests.mjs can regenerate and byte-compare.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const corpusArgIdx = argv.indexOf('--corpus');
const corpusRoot = path.resolve(
  appDir,
  corpusArgIdx !== -1 && argv[corpusArgIdx + 1] ? argv[corpusArgIdx + 1] : '../Measurements 2',
);

// Fixed identifier bumped by hand when the generation logic changes; NOT a
// timestamp, so regenerated output stays byte-identical for the corpus.
const SUGGESTIONS_VERSION = 'sizeL-suggestions-v1';

// htm POM id (pom-template.json) -> canonical Measurements-2 concept. Join is
// by CONCEPT, never by number — the two systems number POMs differently
// (htm 11/12/13/15 are M2 slots 13/11/12/16). POMs 15/16 have no corpus data.
const CONCEPT_BY_POM = {
  '1': 'band_relax',
  '2': 'band_extended',
  '3': 'chest_relax',
  '4': 'chest_extended',
  '5': 'cf_height',
  '6': 'cradle_cf',
  '7': 'cradle_under_cup',
  '8': 'cup_height_cf',
  '9': 'cup_height',
  '10': 'cup_width',
  '11': 'sideseam_length',
  '12': 'cb_height',
  '13': 'back_panel_height',
  '14': 'strap_length',
  '15': 'back_straps_distance',
  '16': null,
  // US-037: neckline (17) and armhole (18) have no Measurements-2 corpus
  // concept yet — emitted as "no data" until a corpus pass adds them.
  '17': null,
  '18': null,
};

const CORPUS_FILE = 'library/_raw_intake/measurements_size_l.csv';
const CONCEPTS_FILE = 'library/pom_concepts.csv';
const TOL_FILE = 'library/pom_tol_defaults.csv';
const RATIOS_FILE = 'library/sketch_ratios.csv';

function corpusPath(rel) {
  return path.join(corpusRoot, rel);
}

// ---- RFC4180-ish CSV parser (handles quoted fields, doubled quotes, commas
// and newlines inside quotes). Returns an array of row objects keyed by header.
function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      // Ignore blank trailing lines.
      if (field !== '' || record.length) { record.push(field); rows.push(record); }
      field = ''; record = [];
    } else field += c;
  }
  if (field !== '' || record.length) { record.push(field); rows.push(record); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(cols => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = cols[idx] != null ? cols[idx] : ''; });
    return obj;
  });
}

function readCsv(rel) {
  const p = corpusPath(rel);
  if (!existsSync(p)) {
    throw new Error(`Corpus file not found: ${p}\nPass --corpus <path to "Measurements 2">.`);
  }
  return parseCsv(readFileSync(p, 'utf8'));
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Percentile on an already-sorted array (linear interpolation).
function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  if (n === 1) return sorted[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Confidence for a library prior: a population median is never "high" for a
// specific style, so cap the sample-size tier at medium, then floor it by the
// POM's expected detection tier (a strap POM stays low even with many samples).
const TIER_RANK = { very_low: 0, low: 1, medium: 2, high: 3 };
const RANK_TIER = ['very_low', 'low', 'medium', 'high'];
function deriveConfidence(n, expectedTier) {
  if (!n) return 'very_low';
  const base = n >= 150 ? 'medium' : n >= 50 ? 'low' : 'very_low';
  const exp = TIER_RANK[expectedTier] != null ? expectedTier : 'medium';
  return RANK_TIER[Math.min(TIER_RANK[base], TIER_RANK[exp])];
}

function main() {
  // 1. concept resolver: raw_key -> canonical concept (folds aliases), plus the
  // set of canonical concept names so a legacy old_concept can be recognized.
  const rawKeyToConcept = new Map();
  const conceptNames = new Set();
  for (const row of readCsv(CONCEPTS_FILE)) {
    const rawKey = String(row.raw_key || '').trim();
    const concept = String(row.concept || '').trim();
    if (rawKey && concept) rawKeyToConcept.set(rawKey, concept);
    if (concept) conceptNames.add(concept);
  }

  // Resolve one corpus row to a canonical concept, or null to drop it.
  // Ladder: (a) the normalized raw phrase (pom_key_norm) is a known alias;
  // (b) old_concept is already a canonical concept name (e.g. cradle_cf);
  // (c) old_concept with underscores→spaces matches a raw alias — this folds
  // legacy names like center_back_height → "center back height" → cb_height.
  // Anything left (raw_* intake phrases, front_height, body_length) is dropped
  // as not-yet-canonicalized rather than guessed at.
  function resolveConcept(row) {
    const key = String(row.pom_key_norm || '').trim();
    if (rawKeyToConcept.has(key)) return rawKeyToConcept.get(key);
    const oc = String(row.old_concept || '').trim();
    if (!oc) return null;
    if (conceptNames.has(oc)) return oc;
    const spaced = oc.replace(/_/g, ' ');
    if (rawKeyToConcept.has(spaced)) return rawKeyToConcept.get(spaced);
    return null;
  }

  // 2. corpus values grouped by canonical concept.
  const corpusRows = readCsv(CORPUS_FILE);
  const valuesByConcept = new Map();
  let droppedRows = 0;
  for (const row of corpusRows) {
    const v = parseFloat(String(row.size_l_in || '').trim());
    if (!Number.isFinite(v)) continue;
    const concept = resolveConcept(row);
    if (!concept) { droppedRows++; continue; }
    if (!valuesByConcept.has(concept)) valuesByConcept.set(concept, []);
    valuesByConcept.get(concept).push(v);
  }
  const styleVersions = new Set(corpusRows.map(r => String(r.style_id || '').trim()).filter(Boolean)).size;

  // 3. tolerance defaults by concept.
  const tolByConcept = new Map();
  for (const row of readCsv(TOL_FILE)) {
    const concept = String(row.concept || '').trim();
    if (concept) tolByConcept.set(concept, { tol: String(row.tol || '').trim() || null, tolType: String(row.tol_type || '').trim() || null });
  }

  // 4. sketch reliability by concept.
  const reliableByConcept = new Map();
  for (const row of readCsv(RATIOS_FILE)) {
    const concept = String(row.concept || '').trim();
    if (concept) reliableByConcept.set(concept, String(row.is_ratio_reliable || '').trim().toUpperCase() === 'TRUE');
  }

  // Expected confidence tiers straight from the POM template contract.
  const template = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/pom-template.json'), 'utf8'));
  const expectedTierByPom = {};
  for (const r of template.rows) expectedTierByPom[String(r.id)] = r.expected_confidence_tier || 'medium';

  // 5. assemble per-POM suggestions.
  const poms = {};
  for (const pomId of Object.keys(CONCEPT_BY_POM)) {
    const concept = CONCEPT_BY_POM[pomId];
    const values = concept ? (valuesByConcept.get(concept) || []) : [];
    const n = values.length;
    if (!concept || !n) {
      poms[pomId] = {
        concept: concept || null,
        median: null, min: null, max: null,
        tol: concept && tolByConcept.has(concept) ? tolByConcept.get(concept).tol : null,
        tolType: concept && tolByConcept.has(concept) ? tolByConcept.get(concept).tolType : null,
        sketchReliable: concept && reliableByConcept.has(concept) ? reliableByConcept.get(concept) : null,
        n: 0,
        confidence: 'very_low',
        source: 'none',
      };
      continue;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const tol = tolByConcept.get(concept) || { tol: null, tolType: null };
    poms[pomId] = {
      concept,
      median: round3(median(sorted)),
      // Light 2nd/98th-percentile trim keeps the displayed range robust to
      // mis-keyed outliers (e.g. chest_extended min) without discarding data.
      min: round3(percentile(sorted, 2)),
      max: round3(percentile(sorted, 98)),
      tol: tol.tol,
      tolType: tol.tolType,
      sketchReliable: reliableByConcept.has(concept) ? reliableByConcept.get(concept) : null,
      n,
      confidence: deriveConfidence(n, expectedTierByPom[pomId]),
      source: 'library',
    };
  }

  const out = {
    suggestions_version: SUGGESTIONS_VERSION,
    unit: 'in',
    provenance: {
      corpus: `Measurements 2/${CORPUS_FILE}`,
      conceptMap: `Measurements 2/${CONCEPTS_FILE}`,
      tolDefaults: `Measurements 2/${TOL_FILE}`,
      sketchRatios: `Measurements 2/${RATIOS_FILE}`,
      generatedBy: 'scripts/generate-sizeL-suggestions.mjs',
      corpusRows: corpusRows.length,
      styleVersions,
      droppedRows,
      note: 'Derived from the approved Size-L corpus. Regenerate with the generator; never hand-edit. droppedRows = corpus rows whose concept is not yet canonicalized (raw_* intake phrases).',
    },
    poms,
  };

  const json = JSON.stringify(out, null, 2) + '\n';
  const outPath = path.join(appDir, 'auto_mode_rules/sizeL-suggestions.json');

  if (checkOnly) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
    if (current !== json) {
      console.error('sizeL-suggestions.json is stale — re-run: node scripts/generate-sizeL-suggestions.mjs');
      process.exit(1);
    }
    console.log('sizeL-suggestions.json is up to date with the corpus.');
    return;
  }

  writeFileSync(outPath, json);
  const filled = Object.values(poms).filter(p => p.n > 0).length;
  console.log(`Wrote auto_mode_rules/sizeL-suggestions.json — ${filled}/18 POMs from ${corpusRows.length} corpus rows (${styleVersions} style-versions).`);
}

main();
