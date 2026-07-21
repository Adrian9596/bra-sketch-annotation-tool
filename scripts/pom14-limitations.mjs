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
} from './lib/synthetic-detection.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = loadPipeline(appDir);

// A symmetric front bra blob (cups, chest, band, CF axis, side seams) centered
// in its own box. Mirrors scripts/viewrole-limitations.mjs drawFront.
function drawFront(setDark, bx, top, boxW, boxH) {
  const cx = bx;
  const halfBox = Math.round(boxW / 2);
  const cupR = Math.min(halfBox, boxH * 0.16) * 0.85;
  const cupY = top + boxH * 0.40;
  const bandY = Math.round(top + boxH * 0.82);
  const bandThickness = Math.max(3, Math.round(boxH * 0.04));
  const chestY = Math.round(top + boxH * 0.30);
  const sideLX = Math.round(cx - halfBox);
  const sideRX = Math.round(cx + halfBox);
  for (let theta = 0; theta < Math.PI * 2; theta += 0.005) {
    const xL = Math.round(cx - cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    const yL = Math.round(cupY + Math.sin(theta) * cupR);
    const xR = Math.round(cx + cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    setDark(xL, yL); setDark(xL, yL + 1);
    setDark(xR, yL); setDark(xR, yL + 1);
  }
  const chestSpanHalf = Math.round(halfBox * 0.92);
  for (let x = cx - chestSpanHalf; x <= cx + chestSpanHalf; x += 1) setDark(Math.round(x), chestY);
  for (let dy = 0; dy < bandThickness; dy += 1) {
    for (let x = sideLX; x <= sideRX; x += 1) setDark(x, bandY + dy);
  }
  for (let y = Math.round(top + boxH * 0.06); y <= bandY; y += 1) setDark(Math.round(cx), y);
  for (let y = chestY; y <= bandY + bandThickness; y += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      setDark(sideLX - dx, y);
      setDark(sideRX + dx, y);
    }
  }
}

// An asymmetric back panel: rectangular outline, a strong vertical center-back
// seam, and a single off-center back strap running up from the panel top. The
// strap + panel edges give findBackPanelHeight (strap↔panel join → strap-bottom)
// real ink to seed the back end of POM 14.
// Mirrors scripts/viewrole-limitations.mjs drawBack.
function drawBack(setDark, bx, top, boxW, boxH) {
  const cx = bx;
  const halfBox = Math.round(boxW / 2);
  const bandY = Math.round(top + boxH * 0.85);
  const chestY = Math.round(top + boxH * 0.25);
  const sideLX = Math.round(cx - halfBox);
  const sideRX = Math.round(cx + halfBox);
  for (let y = chestY; y <= bandY; y += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      setDark(sideLX - dx, y);
      setDark(sideRX + dx, y);
    }
  }
  const thickness = Math.max(3, Math.round(boxH * 0.04));
  for (let dy = 0; dy < thickness; dy += 1) {
    for (let x = sideLX; x <= sideRX; x += 1) {
      setDark(x, chestY + dy);
      setDark(x, bandY + dy);
    }
  }
  for (let y = chestY; y <= bandY; y += 1) {
    for (let dx = -1; dx <= 1; dx += 1) setDark(Math.round(cx) + dx, y);
  }
  // Off-center back strap up from the panel top — POM 14's back-strap ink.
  for (let y = top; y <= chestY; y += 1) setDark(Math.round(cx - halfBox * 0.5), y);
}

function pack(canvas, engine) {
  return {
    engine,
    width: canvas.stats.colDark.length,
    height: canvas.stats.rowDark.length,
    total: canvas.stats.colDark.length * canvas.stats.rowDark.length,
    mask: canvas.mask,
    stats: canvas.stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

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
