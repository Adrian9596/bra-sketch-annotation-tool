#!/usr/bin/env node
// Line-level measurement accuracy harness (US-039, Stage 0 / S0.1).
//
// Mirrors scripts/accuracy-tests.mjs — which scores detector *anchor seeds*
// against TD ground truth — but scores each POM's *measurement value* (inches)
// against TD ground truth, with the same one-sided regression gate (worse
// fails, better passes and hints --update).
//
// It is deliberately NON-BLOCKING until two things exist, exactly like the
// anchor gate was until its ground truth landed:
//   1. a ground-truth file promoted from `draft_pending_td` to `td_confirmed`
//      (drafts are reported and schema-checked, but never gate), and
//   2. a measured-value source (`--measured <file>`), which Stage 1 wires from
//      the lab/production measurement engine output.
//
// The scoring + gate math is pure and can be proven at any time, offline and
// browserless:
//   node scripts/measurement-accuracy-tests.mjs --selftest
//
// Usage:
//   node scripts/measurement-accuracy-tests.mjs                 # validate GT + report
//   node scripts/measurement-accuracy-tests.mjs --measured=run.json   # score + gate
//   node scripts/measurement-accuracy-tests.mjs --measured=run.json --update  # ratchet baseline
//   node scripts/measurement-accuracy-tests.mjs --selftest      # prove the gate math
//
// Gate epsilons (inches, env-overridable):
//   MEASURE_GATE_MEAN_EPS (0.01), MEASURE_GATE_MAX_EPS (0.02), MEASURE_GATE_POM_EPS (0.02)
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const gtDir = path.join(scriptDir, 'groundtruth', 'measurements');
const BASELINE_PATH = path.join(scriptDir, 'groundtruth', 'measurement-accuracy-baseline.json');
const GATE_MEAN_EPS = Number(process.env.MEASURE_GATE_MEAN_EPS || 0.01);
const GATE_MAX_EPS = Number(process.env.MEASURE_GATE_MAX_EPS || 0.02);
const GATE_POM_EPS = Number(process.env.MEASURE_GATE_POM_EPS || 0.02);

function parseArgs(argv) {
  const out = { _: [] };
  for (const tok of argv) {
    if (tok.startsWith('--')) { const [k, v] = tok.slice(2).split('='); out[k] = v === undefined ? true : v; }
    else out._.push(tok);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const round4 = x => Math.round(x * 1e4) / 1e4;
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const maxOf = xs => (xs.length ? Math.max(...xs) : 0);

// ---- pure scoring --------------------------------------------------------
// measuredByImage: { <image>: { <pom>: value_in } }
// gtByImage:       { <image>: { source, measurements: { <pom>: { value_in } } } }
export function scoreMeasurements(measuredByImage, gtByImage, options = {}) {
  const gatedOnly = !!options.gatedOnly;
  const perImage = {}, perPomErrs = {}, all = [];
  for (const [image, gt] of Object.entries(gtByImage || {})) {
    if (gatedOnly && gt.source !== 'td_confirmed') continue;
    const measured = (measuredByImage || {})[image] || {};
    const errs = [];
    for (const [pom, cell] of Object.entries(gt.measurements || {})) {
      const truth = Number(cell && cell.value_in);
      const got = Number(measured[pom]);
      if (!Number.isFinite(truth) || !Number.isFinite(got)) continue;
      const err = Math.abs(got - truth);
      errs.push(err); all.push(err);
      (perPomErrs[pom] = perPomErrs[pom] || []).push(err);
    }
    if (errs.length) perImage[image] = { mean: round4(mean(errs)), max: round4(maxOf(errs)), scored: errs.length };
  }
  const perPom = {};
  for (const [pom, e] of Object.entries(perPomErrs).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    perPom[pom] = { mean: round4(mean(e)), n: e.length };
  }
  return {
    unit: 'in', perImage, perPom,
    overall: { mean: round4(mean(all)), max: round4(maxOf(all)), scored: all.length, images: Object.keys(perImage).length },
  };
}

// ---- one-sided regression gate (worse fails, better passes) --------------
export function runMeasurementGate(current, baseline) {
  const failures = [], improvements = [];
  for (const [image, b] of Object.entries(baseline.perImage || {})) {
    const c = current.perImage[image];
    if (!c) { failures.push(`${image}: in baseline but not scored this run`); continue; }
    if (c.mean > b.mean + GATE_MEAN_EPS) failures.push(`${image}: mean value error ${c.mean} regressed past baseline ${b.mean} in`);
    if (c.max > b.max + GATE_MAX_EPS) failures.push(`${image}: max value error ${c.max} regressed past baseline ${b.max} in`);
    if (c.mean < b.mean - GATE_MEAN_EPS) improvements.push(`${image}: mean ${b.mean} -> ${c.mean} in`);
  }
  for (const [pom, b] of Object.entries(baseline.perPom || {})) {
    const c = current.perPom[pom];
    if (c && c.mean > b.mean + GATE_POM_EPS) failures.push(`POM ${pom}: mean value error ${c.mean} regressed past baseline ${b.mean} in`);
  }
  if (baseline.overall && current.overall.mean > baseline.overall.mean + GATE_MEAN_EPS) {
    failures.push(`overall: mean value error ${current.overall.mean} regressed past baseline ${baseline.overall.mean} in`);
  }
  return { failures, improvements };
}

// ---- io ------------------------------------------------------------------
function loadGroundTruth() {
  if (!existsSync(gtDir)) return {};
  const out = {};
  for (const file of readdirSync(gtDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(path.join(gtDir, file), 'utf8'));
    out[parsed.image || file.replace(/\.json$/, '')] = parsed;
  }
  return out;
}

function validateGroundTruth(gtByImage) {
  const problems = [];
  for (const [image, gt] of Object.entries(gtByImage)) {
    if (!gt.source) problems.push(`${image}: missing "source"`);
    if (!gt.measurements || typeof gt.measurements !== 'object') { problems.push(`${image}: missing "measurements"`); continue; }
    for (const [pom, cell] of Object.entries(gt.measurements)) {
      if (!Number.isFinite(Number(cell && cell.value_in))) problems.push(`${image} POM ${pom}: non-numeric value_in`);
    }
  }
  return problems;
}

function loadMeasured() {
  if (!args.measured || args.measured === true) return null;
  const p = path.isAbsolute(args.measured) ? args.measured : path.join(appDir, args.measured);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadLibraryMedians() {
  try {
    const j = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules', 'sizeL-suggestions.json'), 'utf8'));
    const m = {};
    for (const [pom, v] of Object.entries(j.poms || {})) if (Number(v && v.median) > 0) m[pom] = Number(v.median);
    return m;
  } catch (_e) { return {}; }
}

// ---- per-POM promotion (US-041) ------------------------------------------
// A POM is eligible for Mode B roll-out only when, on TD-confirmed ground truth,
// its FUSED value beats library-only (lower mean abs error). This is the gate
// between "measured" and "shown to users" — mirrors golden/accuracy --update as
// a reviewed step: it recommends the MODE_B_ENABLED_POMS list; a human edits it.
export function promotionEligibility(measuredByImage, gtByImage, libraryMedians, eps) {
  eps = eps == null ? 0.001 : eps;
  const per = {};
  for (const [image, gt] of Object.entries(gtByImage || {})) {
    if (!gt || gt.source !== 'td_confirmed') continue;              // drafts never promote
    const measured = (measuredByImage || {})[image] || {};
    for (const [pom, cell] of Object.entries(gt.measurements || {})) {
      const truth = Number(cell && cell.value_in);
      const fused = Number(measured[pom]);
      const lib = Number((libraryMedians || {})[pom]);
      if (!Number.isFinite(truth) || !Number.isFinite(fused) || !Number.isFinite(lib)) continue;
      const p = (per[pom] = per[pom] || { fusion: 0, library: 0, n: 0 });
      p.fusion += Math.abs(fused - truth);
      p.library += Math.abs(lib - truth);
      p.n += 1;
    }
  }
  const eligible = [], rows = [];
  for (const [pom, p] of Object.entries(per)) {
    const fMean = p.fusion / p.n, lMean = p.library / p.n;
    const win = fMean <= lMean - eps;                                // fusion strictly better
    if (win) eligible.push(pom);
    rows.push({ pom, n: p.n, fusionMean: round4(fMean), libraryMean: round4(lMean), win });
  }
  eligible.sort((a, b) => Number(a) - Number(b));
  rows.sort((a, b) => Number(a.pom) - Number(b.pom));
  return { eligible, rows };
}

// ---- selftest (proves the machinery without a browser or real data) ------
function selftest() {
  console.log('=== measurement-accuracy selftest ===');
  const gt = { A: { source: 'td_confirmed', measurements: { 1: { value_in: 14 }, 5: { value_in: 5.5 } } } };
  const perfect = scoreMeasurements({ A: { 1: 14, 5: 5.5 } }, gt, { gatedOnly: true });
  assert.equal(perfect.overall.mean, 0, 'identical measured == GT gives 0 mean error');
  assert.equal(perfect.overall.scored, 2, 'both POMs scored');

  const baseline = scoreMeasurements({ A: { 1: 14.1, 5: 5.6 } }, gt, { gatedOnly: true }); // mean 0.1
  const identical = runMeasurementGate(baseline, baseline);
  assert.equal(identical.failures.length, 0, 'identical run passes the gate');

  const better = scoreMeasurements({ A: { 1: 14.0, 5: 5.5 } }, gt, { gatedOnly: true });
  const betterGate = runMeasurementGate(better, baseline);
  assert.equal(betterGate.failures.length, 0, 'an improvement never fails');
  assert.ok(betterGate.improvements.length > 0, 'an improvement is reported for --update');

  const worse = scoreMeasurements({ A: { 1: 15, 5: 6.5 } }, gt, { gatedOnly: true });
  const worseGate = runMeasurementGate(worse, baseline);
  assert.ok(worseGate.failures.length > 0, 'a regression fails the gate');

  const draftGt = { B: { source: 'draft_pending_td', measurements: { 1: { value_in: 14 } } } };
  const draftScore = scoreMeasurements({ B: { 1: 99 } }, draftGt, { gatedOnly: true });
  assert.equal(draftScore.overall.scored, 0, 'draft_pending_td GT is never gated');

  // promotion: POM 9 fused beats library, POM 10 fused worse; POM 1 GT is draft.
  const promGt = {
    C: { source: 'td_confirmed', measurements: { 9: { value_in: 8.2 }, 10: { value_in: 8.0 } } },
    D: { source: 'draft_pending_td', measurements: { 1: { value_in: 14 } } },
  };
  const promMeasured = { C: { 9: 8.15, 10: 9.2 }, D: { 1: 20 } };
  const lib = { 9: 8.0, 10: 8.0, 1: 14 };
  const prom = promotionEligibility(promMeasured, promGt, lib);
  assert.deepEqual(prom.eligible, ['9'], 'only the POM whose fusion beats library is eligible');
  assert.ok(!prom.rows.some(r => r.pom === '1'), 'draft GT never enters promotion');

  console.log('  PASS  identical run passes');
  console.log('  PASS  improvement passes and is reported');
  console.log('  PASS  regression fails');
  console.log('  PASS  draft_pending_td ground truth does not gate');
  console.log('  PASS  promotion picks only POMs where fusion beats library (td_confirmed only)');
  console.log('\nmeasurement-accuracy selftest: OK (5/5)');
}

// ---- main ----------------------------------------------------------------
function main() {
  if (args.selftest) { selftest(); return; }

  const gt = loadGroundTruth();
  console.log('=== Measurement accuracy (per-POM value vs TD ground truth) ===');
  const tdConfirmed = Object.values(gt).filter(g => g.source === 'td_confirmed').length;
  const drafts = Object.keys(gt).length - tdConfirmed;
  console.log(`ground-truth files: ${Object.keys(gt).length} (${tdConfirmed} td_confirmed, ${drafts} draft_pending_td)`);
  for (const [image, g] of Object.entries(gt)) {
    console.log(`  ${image}: ${Object.keys(g.measurements || {}).length} POM(s) [${g.source}]`);
  }

  const problems = validateGroundTruth(gt);
  if (problems.length) {
    for (const p of problems) console.log(`  SCHEMA ERROR  ${p}`);
    process.exitCode = 1;
    return;
  }

  const measured = loadMeasured();
  if (!measured) {
    console.log('\nNo measured-value source (--measured <file>) — report-only, gate inactive.');
    console.log('Stage 1 feeds the lab/production measurement engine output here to activate the gate.');
    console.log('Prove the gate math now with: node scripts/measurement-accuracy-tests.mjs --selftest');
    return;
  }

  // --promote (US-041): recommend which POMs to enable, gated on td_confirmed GT
  // where the fused value beats library-only. A reviewed step — it PRINTS the
  // MODE_B_ENABLED_POMS list to paste into src/auto/measure/fusion.js.
  if (args.promote) {
    const prom = promotionEligibility(measured, gt, loadLibraryMedians());
    console.log('\n--- per-POM promotion (fusion vs library on td_confirmed GT) ---');
    if (!prom.rows.length) {
      console.log('  No td_confirmed ground truth yet — nothing to promote.');
      console.log('  (Label real values + set "source":"td_confirmed" in scripts/groundtruth/measurements/*.)');
      return;
    }
    for (const r of prom.rows) {
      console.log(`  POM ${String(r.pom).padStart(2)}: fusion ${r.fusionMean} in vs library ${r.libraryMean} in (n=${r.n}) → ${r.win ? 'PROMOTE' : 'keep library'}`);
    }
    console.log('\n  Recommended: const MODE_B_ENABLED_POMS = ' + JSON.stringify(prom.eligible) + ';');
    console.log('  Paste into src/auto/measure/fusion.js after review, then rebuild.');
    return;
  }

  const current = scoreMeasurements(measured, gt, { gatedOnly: true });
  console.log(`\nscored ${current.overall.scored} td_confirmed POM value(s) across ${current.overall.images} image(s); overall mean error ${current.overall.mean} in`);

  if (current.overall.scored === 0) {
    console.log('No td_confirmed ground truth to score yet — gate inactive (drafts are report-only).');
    return;
  }

  if (args.update) {
    writeFileSync(BASELINE_PATH, JSON.stringify({
      _README: 'Measurement accuracy regression baseline — seeded by `node scripts/measurement-accuracy-tests.mjs --measured=<run> --update`. Commit it. Lower is better (inches); the suite fails when a run is worse beyond the gate epsilons.',
      updatedAt: new Date().toISOString(),
      ...current,
    }, null, 2) + '\n');
    console.log(`\nBaseline updated: ${path.relative(appDir, BASELINE_PATH)} (${current.overall.scored} POM values, overall mean ${current.overall.mean} in)`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log('\nNo measurement baseline yet — regression gate inactive.');
    console.log('Seed it with: node scripts/measurement-accuracy-tests.mjs --measured=<run> --update  (then commit it)');
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const { failures, improvements } = runMeasurementGate(current, baseline);
  console.log('\n--- measurement regression gate (vs committed baseline) ---');
  if (failures.length) {
    for (const f of failures) console.log(`  GATE FAIL  ${f}`);
    console.log('\nMeasurement accuracy regressed vs scripts/groundtruth/measurement-accuracy-baseline.json.');
    console.log('If this change is intentionally better overall, re-seed with --update.');
    process.exitCode = 1;
  } else {
    console.log(`  OK — no image, POM, or overall regression (baseline of ${baseline.updatedAt || 'unknown date'})`);
    for (const i of improvements) console.log(`    + ${i}`);
  }
}

main();
