#!/usr/bin/env node
// US-109 / ADR 0083 follow-up: real technical-flat raster pilot fixtures
// (positive/negative/mixed), run through the actual offline runtime.
//
// Corpus (scripts/groundtruth/technical-flat-stitch/, EXPECTED_FIXTURES below):
// the four 2026-09-02 fixtures plus, since 2026-09-03 (US-109 Phase A),
// image6.png (line-art front closure: dashed-topstitch armholes read as
// zigzag, hem zigzag drawn outside the outline), image6-filled.png (a colour
// filled flat WITH zigzag that the classifier still routes to product_photo)
// and Sketch image1.png (two-panel front+back — `unjudgeable`, must abstain
// at image scope). A fixture routed off the technical-flat lane is accepted
// only while it documents an `input_classification` knownGap; otherwise the
// routing is a classifier regression and fails here.
//
// This is the technical-flat-lane sibling of photo-stitch-roi-pilot.mjs: it
// never invents an accuracy threshold and never silently pins a known defect
// as "correct". Ground truth here is primarily existence-only and stays
// draft_pending_td until a TD confirms it. photo4 additionally has broad
// user-corrected path-coverage guards for the exact clipped-neckline/missing-
// armhole regression reported on 2026-09-02 — see
// scripts/groundtruth/technical-flat-stitch/README (this file's header) and
// docs/stories/epics/E07-measurement-detection/US-109-photo-zigzag-detection/
// execplan.md's 2026-09-02 progress note.
//
// What IS asserted (hard failures):
//   - Candidate V3 contract shape/validation and reversible ROI transforms.
//   - No candidate on a zone/side visually confirmed to have no zigzag,
//     UNLESS that exact (zone, side) is listed in the fixture's knownGaps
//     (an already-documented false positive awaiting a P2/P3 fix).
//   - A candidate exists on a zone/side visually confirmed to have zigzag,
//     UNLESS that exact (zone, side) is listed in knownGaps (an already
//     documented false negative awaiting a P2/P3 fix or threshold decision).
// What is reported only (no assertion, no invented threshold):
//   - The live status of every knownGaps entry, so a fix that lands shows up
//     immediately as "no longer reproduces" instead of being silently masked.
//   - Each fixture's inputClass, for the one fixture (image2.png) whose
//     documented gap is at the classification layer, not the zigzag gates.
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessApp, analyzeSeamFixture } from './headless-app.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(appDir, 'scripts/groundtruth/technical-flat-stitch');
const photoDir = path.join(appDir, 'demo/photos for seam detection');
const outputPath = path.join(appDir, 'demo/photo-stitch-technical-flat-predictions.json');
let app;
let assertions = 0;
const check = (condition, message) => { if (!condition) throw new Error(message); assertions += 1; };

const ZONES = new Set(['shoulder_strap', 'neckline', 'armhole', 'cup_edge', 'cup_seam', 'underbust_band', 'side_seam']);
const SIDES = new Set(['left', 'right', 'bilateral', 'center']);
const SOURCES = new Set(['draft_pending_td', 'td_confirmed']);
// wrong_geometry: the zone/side DOES produce a candidate and zigzag DOES exist
// there, but the drawn line sits on the wrong pixels (found on image5.png's
// neckline, ~110 px off). An existence-only pilot cannot verify or refute it;
// it is listed so the gap is on record, and it never excludes the zone from
// the existence assertions below (only false_positive/false_negative do).
const GAP_KINDS = new Set(['false_positive', 'false_negative', 'input_classification', 'wrong_geometry']);
const EXISTENCE_GAP_KINDS = new Set(['false_positive', 'false_negative']);
const key = (zone, side) => `${zone}::${side}`;
// Every file the corpus must contain — a missing ground-truth JSON is a
// corpus regression, not a smaller run.
const EXPECTED_FIXTURES = ['Sketch image1.png', 'image2.png', 'image3.png', 'image5.png', 'image6-filled.png', 'image6.png', 'photo4.png'];

function validateZoneSideList(list, label) {
  check(Array.isArray(list), `${label} must be an array`);
  list.forEach((entry, index) => {
    check(ZONES.has(entry.zone), `${label}[${index}].zone must be one of ${[...ZONES].join('|')}, got ${JSON.stringify(entry.zone)}`);
    check(SIDES.has(entry.side), `${label}[${index}].side must be one of ${[...SIDES].join('|')}, got ${JSON.stringify(entry.side)}`);
  });
}

function validateGroundTruth(gt, filename) {
  check(gt.schemaVersion === 'technical-flat-stitch-groundtruth/1', `${filename}: unknown schemaVersion ${JSON.stringify(gt.schemaVersion)}`);
  check(typeof gt.image === 'string' && gt.image.length > 0, `${filename}: image must be a non-empty string`);
  check(SOURCES.has(gt.source), `${filename}: source must be one of ${[...SOURCES].join('|')}`);
  check(Number.isInteger(gt.width) && gt.width > 0, `${filename}: width must be a positive integer`);
  check(Number.isInteger(gt.height) && gt.height > 0, `${filename}: height must be a positive integer`);
  check(typeof gt.sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(gt.sourceSha256), `${filename}: sourceSha256 must be a 64-char lowercase hex string`);
  check(typeof gt.corpusVersion === 'string' && gt.corpusVersion.length > 0, `${filename}: corpusVersion must be a non-empty string`);
  check(typeof gt.unjudgeable === 'boolean', `${filename}: unjudgeable must be a boolean`);
  validateZoneSideList(gt.observedZigzagZones, `${filename}.observedZigzagZones`);
  validateZoneSideList(gt.confirmedNoZigzagZones, `${filename}.confirmedNoZigzagZones`);
  check(Array.isArray(gt.knownGaps), `${filename}.knownGaps must be an array`);
  gt.knownGaps.forEach((gap, index) => {
    const label = `${filename}.knownGaps[${index}]`;
    check(GAP_KINDS.has(gap.kind), `${label}.kind must be one of ${[...GAP_KINDS].join('|')}`);
    check(gap.zone === null || ZONES.has(gap.zone), `${label}.zone must be null or one of ${[...ZONES].join('|')}`);
    check(gap.side === null || SIDES.has(gap.side), `${label}.side must be null or one of ${[...SIDES].join('|')}`);
    check(typeof gap.description === 'string' && gap.description.trim().length > 0, `${label}.description must be a non-empty string`);
  });
  check(typeof gt.notes === 'string', `${filename}: notes must be a string`);
}

async function main() {
  try { await access(photoDir); } catch {
    console.log('SKIP  photo-stitch-technical-flat-pilot: private pilot photos are absent');
    return;
  }
  const names = (await readdir(corpusDir)).filter(name => name.endsWith('.json')).sort();
  const fixtures = [];
  for (const name of names) {
    const gt = JSON.parse(await readFile(path.join(corpusDir, name), 'utf8'));
    validateGroundTruth(gt, name);
    const bytes = await readFile(path.join(photoDir, gt.image));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    check(actualHash === gt.sourceSha256, `${name}: sourceSha256 does not match ${gt.image} (expected ${actualHash}) — corpus is stale or the photo changed`);
    fixtures.push({ name, gt });
  }
  // Superset, not equality: every EXPECTED fixture must be present (a missing
  // one is a corpus regression), while extra ground-truth files — e.g. a TD's
  // Review ROI export (US-121) dropped into the corpus directory — are run
  // too, without a code edit. Extras are listed so a stray file is visible.
  const present = fixtures.map(f => f.gt.image).sort();
  const missing = EXPECTED_FIXTURES.filter(name => !present.includes(name));
  check(missing.length === 0,
    `technical-flat pilot corpus is missing ${JSON.stringify(missing)} (present: ${JSON.stringify(present)})`);
  const extras = present.filter(name => !EXPECTED_FIXTURES.includes(name));
  if (extras.length) console.log(`  corpus has ${extras.length} fixture(s) beyond EXPECTED_FIXTURES: ${extras.join(', ')} — run as well; add to EXPECTED_FIXTURES once they are meant to be permanent`);

  app = await launchHeadlessApp({ appDir, query: 'technical-flat-pilot', profilePrefix: 'technical-flat-pilot-' });
  const { session } = app;

  const predictions = [];
  let gapsStillReproducing = 0, gapsNoLongerReproducing = 0;
  for (const { gt } of fixtures) {
    const result = await analyzeSeamFixture(session, { relativePath: `demo/photos for seam detection/${gt.image}` });
    check(await session.eval(`window.__braAutoModeDebug.autoSeam.validateResult(${JSON.stringify(result)})`) === true,
      `${gt.image}: result must validate against its lane's contract`);

    if (gt.unjudgeable) {
      // A fixture the runtime must refuse as a whole (Sketch image1.png: two
      // garments, front + back, on one image — ADR 0083 multi-garment). Truth
      // is "abstain at image scope, draw nothing"; per-zone labels do not
      // apply, so the zone lists stay empty and the zone checks are skipped.
      const imageAbstention = result.abstentions.find(a => a.scope === 'image');
      check(result.inputEligible === false, `${gt.image}: unjudgeable fixture must be ineligible, got inputEligible=${result.inputEligible}`);
      check(result.candidates.length === 0, `${gt.image}: unjudgeable fixture must produce no candidate, got ${result.candidates.length}`);
      check(!!imageAbstention, `${gt.image}: unjudgeable fixture must record an image-scope abstention`);
      console.log(`  ${gt.image.padEnd(18)} inputClass=${result.inputClass.value.padEnd(13)} lane=${String(result.analysisLane).padEnd(14)} UNJUDGEABLE (${gt.unjudgeableReason}) -> image abstention ${imageAbstention.code}: ${imageAbstention.reason}`);
      predictions.push({
        image: gt.image, sourceSha256: gt.sourceSha256, unjudgeable: true,
        inputClass: result.inputClass, analysisLane: result.analysisLane, inputEligible: result.inputEligible,
        candidates: [],
        abstentions: result.abstentions.map(a => ({ scope: a.scope, zone: a.zone ?? null, side: a.side ?? null, code: a.code })),
      });
      continue;
    }

    if (result.analysisLane === 'technical_flat') {
      check(result.contractVersion === 'auto-seam-candidate/3', `${gt.image}: Candidate V3 must be emitted`);
    } else {
      // Routed off the technical-flat lane. Tolerated only while the fixture
      // documents it (image6-filled.png); an undocumented re-route is a
      // classifier regression.
      check(gt.knownGaps.some(gap => gap.kind === 'input_classification'),
        `${gt.image}: routed to lane ${result.analysisLane} (${result.inputClass.value}, ${result.inputClass.ruleId || result.inputClass.rule || 'rule n/a'}) without an input_classification knownGap — classifier regression`);
    }
    check(result.candidates.every(candidate => candidate.roiTransform.roundTripMaxErrorPx <= 0.01),
      `${gt.image}: every candidate must retain a reversible ROI/source transform`);

    // This corpus is TD-labelled for Zigzag existence only. V3 may also emit
    // other review-required appearances, which must not be judged against a
    // Zigzag-only label set.
    const observed = new Map(result.candidates
      .filter(candidate => candidate.appearanceType === 'zigzag')
      .map(candidate => [key(candidate.semanticZone, candidate.side), candidate]));
    const gapKeys = new Set(gt.knownGaps.filter(gap => gap.zone && EXISTENCE_GAP_KINDS.has(gap.kind)).map(gap => key(gap.zone, gap.side)));

    for (const entry of gt.confirmedNoZigzagZones) {
      const k = key(entry.zone, entry.side);
      if (gapKeys.has(k)) continue; // documented false positive, reported below instead
      check(!observed.has(k), `${gt.image}: ${entry.zone}/${entry.side} is visually confirmed plain (no zigzag) but the runtime produced a candidate there — new false positive`);
    }
    for (const entry of gt.observedZigzagZones) {
      const k = key(entry.zone, entry.side);
      if (gapKeys.has(k)) continue; // documented false negative, reported below instead
      check(observed.has(k), `${gt.image}: ${entry.zone}/${entry.side} is visually confirmed zigzag but the runtime produced no candidate there — regression on a previously-working detection`);
    }

    if (gt.image === 'photo4.png') {
      check(result.candidates.length === 5,
        'photo4.png: user-corrected result must contain exactly the two shoulder straps, full neckline, and two armholes');

      const neckline = observed.get(key('neckline', 'bilateral'));
      check(neckline.geometry.points.length >= 5,
        'photo4.png: neckline must retain enough curve anchors to cover the full binding');
      check(neckline.geometry.start.x <= 0.23 && neckline.geometry.end.x >= 0.77,
        'photo4.png: neckline must extend from the left strap junction to the right strap junction');
      check(neckline.geometry.start.y >= 0.35 && neckline.geometry.start.y <= 0.42
          && neckline.geometry.end.y >= 0.35 && neckline.geometry.end.y <= 0.42,
        'photo4.png: neckline endpoints must stay on the binding junctions, not climb the shoulder-strap outlines');
      check(neckline.geometry.points[0].point.x <= 0.32
          && neckline.geometry.points.at(-1).point.x >= 0.68,
        'photo4.png: neckline must trace both steep overlap flanks instead of bridging them with long diagonal shortcuts');

      const leftArmhole = observed.get(key('armhole', 'left'));
      const rightArmhole = observed.get(key('armhole', 'right'));
      check(leftArmhole.geometry.start.x <= 0.18 && leftArmhole.geometry.end.x <= 0.03
          && leftArmhole.geometry.end.y - leftArmhole.geometry.start.y >= 0.20,
        'photo4.png: left armhole must cover the outer zigzag binding from junction to side');
      check(rightArmhole.geometry.start.x >= 0.82 && rightArmhole.geometry.end.x >= 0.97
          && rightArmhole.geometry.end.y - rightArmhole.geometry.start.y >= 0.20,
        'photo4.png: right armhole must cover the outer zigzag binding from junction to side');
    }

    console.log(`  ${gt.image.padEnd(11)} inputClass=${result.inputClass.value.padEnd(13)} lane=${String(result.analysisLane).padEnd(14)} eligible=${String(result.inputEligible).padEnd(5)} rois=${result.automaticRois.length} candidates=${result.candidates.length} abstentions=${result.abstentions.length}`);
    for (const gap of gt.knownGaps) {
      if (gap.kind === 'input_classification') {
        const stillReproducing = result.inputClass.value !== 'technical_flat';
        console.log(`    knownGap[input_classification]: expected technical_flat, currently ${result.inputClass.value} — ${stillReproducing ? 'still reproducing' : 'NO LONGER REPRODUCING, consider updating the fixture'}`);
        stillReproducing ? gapsStillReproducing += 1 : gapsNoLongerReproducing += 1;
        continue;
      }
      const k = key(gap.zone, gap.side);
      const present = observed.has(k);
      if (gap.kind === 'wrong_geometry') {
        console.log(`    knownGap[wrong_geometry] ${gap.zone}/${gap.side}: candidate ${present ? 'present' : 'absent'} — existence-only pilot cannot verify line placement; see the fixture's description (unresolved until a geometry check exists)`);
        gapsStillReproducing += 1;
        continue;
      }
      const stillReproducing = gap.kind === 'false_positive' ? present : !present;
      console.log(`    knownGap[${gap.kind}] ${gap.zone}/${gap.side}: candidate ${present ? 'present' : 'absent'} — ${stillReproducing ? 'still reproducing' : 'NO LONGER REPRODUCING, consider updating the fixture'}`);
      stillReproducing ? gapsStillReproducing += 1 : gapsNoLongerReproducing += 1;
    }

    predictions.push({
      image: gt.image, sourceSha256: gt.sourceSha256,
      inputClass: result.inputClass, analysisLane: result.analysisLane, inputEligible: result.inputEligible,
      candidates: result.candidates.map(c => ({ zone: c.semanticZone, side: c.side, overall: c.confidence.overall })),
      abstentions: result.abstentions.map(a => ({ zone: a.zone, side: a.side, code: a.code })),
    });
  }
  await writeFile(outputPath, `${JSON.stringify({ pipelineVersion: 'auto-seam-candidate-v2', generatedAt: new Date().toISOString(), predictions }, null, 2)}\n`);

  console.log(`  known gaps: ${gapsStillReproducing} still reproducing, ${gapsNoLongerReproducing} no longer reproducing (see above if any — update the fixture's knownGaps)`);
  console.log(`PASS  photo-stitch-technical-flat-pilot   ${assertions} assertions ok`);
}

try { await main(); } catch (error) { process.exitCode = 1; console.error(`FAIL  photo-stitch-technical-flat-pilot\n${error.stack || error}`); }
finally { await app?.close(); }
