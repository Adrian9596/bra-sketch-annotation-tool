#!/usr/bin/env node
// Synthetic diagnostic matrix for POM 14 (shoulder strap length).
//
// POM 14 is the shoulder-strap LENGTH, measured as a curved path from the front
// strap upper joining seam to the end of the shoulder strap at the back.
//
// Hard invariants asserted here (a change flips the case to FAIL):
//   - Front+back sketch: POM 14 is DRAWABLE, curved, never high confidence,
//     starts on the front strap upper join and ends at the back strap end.
//   - Front-only sketch (no back view): POM 14 REFUSES to guess — it demotes to
//     REVIEW_ONLY because the back strap end is absent.
//
// The headless VM machinery is shared via scripts/lib/synthetic-detection.mjs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPipeline,
  makeInkCanvas,
  runPipeline,
  pomRow,
  runCases,
  drawFront,
  drawBack,
  pack,
} from './lib/synthetic-detection.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = loadPipeline(appDir);

// Front (left) + back (right, with strap) — a normal 2-view tech pack. POM 14
// curves from the front strap upper join to the back strap end.
function buildFrontBack(width, height) {
  const c = makeInkCanvas(width, height);
  drawFront(c.setDark, Math.round(width * 0.27), Math.round(height * 0.18), Math.round(width * 0.26), Math.round(height * 0.64));
  drawBack(c.setDark, Math.round(width * 0.75), Math.round(height * 0.15), Math.round(width * 0.24), Math.round(height * 0.70));
  return pack(c, 'pom14-front-back');
}

// A single centered front blob — no back view, so POM 14 cannot be sourced.
function buildFrontOnly(width, height) {
  const c = makeInkCanvas(width, height);
  drawFront(c.setDark, Math.round(width * 0.5), Math.round(height * 0.15), Math.round(width * 0.30), Math.round(height * 0.70));
  return pack(c, 'pom14-front-only');
}

function classifyPom14(item) {
  const { detection, anchors, fixture } = runPipeline(pipeline, item.analysis, { id: item.id });
  const pom14 = pomRow(fixture, 14);
  const strapTop = anchors.find((a) => a.kind === 'strap-top');
  const strapBot = anchors.find((a) => a.kind === 'strap-bottom');
  const notes = [
    `views=${detection.views ? detection.views.length : '?'} backViewIndex=${detection.backViewIndex}`,
    `pom14 type=${pom14 && pom14.type} drawability=${pom14 && pom14.drawability} confidence=${pom14 && pom14.confidence}`,
    `strap-top: ${strapTop ? `viewRole=${strapTop.viewRole} y=${strapTop.y.toFixed(3)} conf=${strapTop.confidence} src=${strapTop.source} rr=${strapTop.reviewRequired}` : 'absent'}`,
    `strap-bottom: ${strapBot ? `viewRole=${strapBot.viewRole} y=${strapBot.y.toFixed(3)} conf=${strapBot.confidence} src=${strapBot.source} rr=${strapBot.reviewRequired}` : 'absent'}`,
  ];

  if (item.mode === 'frontonly') {
    const reviewOnly = !!pom14 && pom14.drawability === 'REVIEW_ONLY';
    const backEndAbsent = !strapBot;
    return {
      actual: `review-only=${reviewOnly ? 'yes' : 'no'} back-end-absent=${backEndAbsent ? 'yes' : 'no'}`,
      detail: '(front-only sketch: no back end to complete strap length)',
      notes,
    };
  }

  // Two-view (front+back): POM 14 curves from the front strap upper join to the back strap end.
  const drawable = !!pom14 && pom14.drawability === 'DRAWABLE';
  const curved = !!pom14 && pom14.type === 'curved';
  const notHigh = !!pom14 && pom14.confidence !== 'high';
  const rolesOk = !!strapTop && !!strapBot && strapTop.viewRole === 'front_outer' && strapBot.viewRole === 'back';
  return {
    actual: `drawable=${drawable ? 'yes' : 'no'} curved=${curved ? 'yes' : 'no'} not-high=${notHigh ? 'yes' : 'no'} roles-ok=${rolesOk ? 'yes' : 'no'}`,
    detail: '(POM 14 measured from front strap upper join to back strap end)',
    notes,
  };
}

const cases = [
  {
    id: 'front-back-strap',
    mode: 'twoview',
    label: 'front + back (with back strap): POM 14 curves from front strap upper join to back strap end',
    hardExpected: 'drawable=yes curved=yes not-high=yes roles-ok=yes',
    analysis: buildFrontBack(900, 480),
  },
  {
    id: 'front-only-review',
    mode: 'frontonly',
    label: 'front-only sketch (no back view): POM 14 refuses to guess → REVIEW_ONLY, back end absent',
    hardExpected: 'review-only=yes back-end-absent=yes',
    analysis: buildFrontOnly(900, 480),
  },
];

runCases('POM 14 synthetic diagnostic matrix (front-to-back strap length)', cases, classifyPom14, {
  guardLabel: 'POM 14 diagnostic',
});
