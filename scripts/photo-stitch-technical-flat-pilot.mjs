#!/usr/bin/env node
// US-109 / ADR 0083 follow-up: real technical-flat raster pilot fixtures
// (positive/negative/mixed), run through the actual offline runtime.
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
  check(fixtures.length === 4, `expected the 4 technical-flat pilot fixtures, got ${fixtures.length}`);

  app = await launchHeadlessApp({ appDir, query: 'technical-flat-pilot', profilePrefix: 'technical-flat-pilot-' });
  const { session } = app;

  const predictions = [];
  let gapsStillReproducing = 0, gapsNoLongerReproducing = 0;
  for (const { gt } of fixtures) {
    const result = await analyzeSeamFixture(session, { relativePath: `demo/photos for seam detection/${gt.image}` });
    check(result?.contractVersion === 'auto-seam-candidate/3', `${gt.image}: Candidate V3 must be emitted`);
    check(await session.eval(`window.__braAutoModeDebug.autoSeam.validateResult(${JSON.stringify(result)})`) === true,
      `${gt.image}: Candidate V3 result must validate`);
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
