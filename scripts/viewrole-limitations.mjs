#!/usr/bin/env node
// Synthetic diagnostic matrix for sketch view-role classification.
//
// Unlike the per-POM matrices, this exercises the multi-view classifier that
// decides which detected garment blob is the front_outer / front_inner / back
// view. The back POMs (11/12/13/15) all depend on a back view being found, so
// a regression here silently breaks half the back-panel measurements.
//
// View classification is inherently fuzzier than single-POM seam detection, so
// this suite leans on LIMITATION for the ambiguous layouts and keeps only the
// clear-cut invariants as hard guards:
//   - a single centered SYMMETRIC blob must NOT be classified as a back view;
//   - a clearly-separated front (left, symmetric) + back (right, asymmetric
//     center-seam) layout must identify a back view.
//
// The headless VM machinery is shared via scripts/lib/synthetic-detection.mjs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPipeline,
  makeInkCanvas,
  runPipeline,
  runCases,
} from './lib/synthetic-detection.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = loadPipeline(appDir);

// A symmetric front bra blob: cups, chest line, band, CF axis, side seams,
// centered in its own box. High symmetry, moderate aspect — reads front_outer.
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
// seam, and a single off-center back strap. Tall aspect, heavy edges, low
// symmetry — the signals scoreViewLayout rewards for the 'back' role.
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
  // Single off-center back strap to break left/right symmetry.
  for (let y = top; y <= chestY; y += 1) setDark(Math.round(cx - halfBox * 0.5), y);
}

// A front-inner cutaway: two cup lobes + inner bust line + center closure, with
// minimal outer frame (high interior ink, low edge ink) — the front_inner signal.
function drawInner(setDark, bx, top, boxW, boxH) {
  const cx = bx;
  const halfBox = Math.round(boxW / 2);
  const cupR = Math.min(halfBox, boxH * 0.18);
  const cupY = top + boxH * 0.45;
  for (let theta = 0; theta < Math.PI * 2; theta += 0.004) {
    const xL = Math.round(cx - halfBox * 0.45 + Math.cos(theta) * cupR * 0.7);
    const yL = Math.round(cupY + Math.sin(theta) * cupR);
    const xR = Math.round(cx + halfBox * 0.45 + Math.cos(theta) * cupR * 0.7);
    setDark(xL, yL); setDark(xR, yL);
  }
  for (let x = cx - halfBox * 0.7; x <= cx + halfBox * 0.7; x += 1) setDark(Math.round(x), Math.round(top + boxH * 0.62));
  for (let y = cupY - cupR; y <= cupY + cupR; y += 1) setDark(Math.round(cx), y);
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

// Single centered symmetric front blob only.
function buildSingleSymmetric(width, height) {
  const c = makeInkCanvas(width, height);
  drawFront(c.setDark, Math.round(width * 0.5), Math.round(height * 0.15), Math.round(width * 0.30), Math.round(height * 0.70));
  return pack(c, 'viewrole-single-symmetric');
}

// Front (left, symmetric) + back (right, asymmetric center-seam), separated.
function buildFrontBack(width, height) {
  const c = makeInkCanvas(width, height);
  drawFront(c.setDark, Math.round(width * 0.27), Math.round(height * 0.18), Math.round(width * 0.26), Math.round(height * 0.64));
  drawBack(c.setDark, Math.round(width * 0.75), Math.round(height * 0.15), Math.round(width * 0.24), Math.round(height * 0.70));
  return pack(c, 'viewrole-front-back');
}

// Two near-identical symmetric front blobs — deliberately ambiguous.
function buildAmbiguous(width, height) {
  const c = makeInkCanvas(width, height);
  drawFront(c.setDark, Math.round(width * 0.28), Math.round(height * 0.18), Math.round(width * 0.26), Math.round(height * 0.64));
  drawFront(c.setDark, Math.round(width * 0.72), Math.round(height * 0.18), Math.round(width * 0.26), Math.round(height * 0.64));
  return pack(c, 'viewrole-ambiguous');
}

// Three panels — front_outer (left) + back (mid) + front_inner (right) — well
// separated, so component grouping already yields three boxes.
function buildThreeView(width, height) {
  const c = makeInkCanvas(width, height);
  drawFront(c.setDark, Math.round(width * 0.18), Math.round(height * 0.18), Math.round(width * 0.20), Math.round(height * 0.64));
  drawBack(c.setDark, Math.round(width * 0.50), Math.round(height * 0.15), Math.round(width * 0.20), Math.round(height * 0.70));
  drawInner(c.setDark, Math.round(width * 0.82), Math.round(height * 0.18), Math.round(width * 0.20), Math.round(height * 0.64));
  return pack(c, 'viewrole-three-view');
}

// EvelynBliss's real pattern: the front panel sits apart on the left, while the
// back and front-inner panels sit close on the right and component-grouping
// merges them into ONE over-wide (>0.50w) box. splitWideViewBoxes must split
// that merged box so three view boxes are recovered — without this, the back
// and inner anchors smear across the gap between the two merged panels.
function buildThreeViewTight(width, height) {
  const c = makeInkCanvas(width, height);
  drawFront(c.setDark, Math.round(width * 0.16), Math.round(height * 0.18), Math.round(width * 0.20), Math.round(height * 0.64));
  drawBack(c.setDark, Math.round(width * 0.52), Math.round(height * 0.15), Math.round(width * 0.22), Math.round(height * 0.70));
  drawInner(c.setDark, Math.round(width * 0.82), Math.round(height * 0.18), Math.round(width * 0.22), Math.round(height * 0.64));
  return pack(c, 'viewrole-three-view-tight');
}

function rolesSummary(detection) {
  return detection.views
    .map((v, i) => `${i}:${v.viewRole}@${v.roleConfidence}`)
    .join(' ');
}

// For hard cases the `actual` string encodes the invariant being asserted.
function classifyViewRole(item) {
  const { detection } = runPipeline(pipeline, item.analysis, { id: item.id });
  const backIdx = detection.backViewIndex;
  return {
    actual: item.probe ? item.probe(detection) : `backViewIndex=${backIdx}`,
    detail: `views=${detection.views.length} backViewIndex=${backIdx} reviewRequired=${detection.viewRoleReviewRequired}`,
    notes: [`roles: ${rolesSummary(detection)}`],
  };
}

const cases = [
  {
    id: 'single-symmetric',
    label: 'one centered symmetric blob must not be read as a back view',
    // Robust: a single symmetric front view is forced to front_outer, so no
    // back view should be identified.
    hardExpected: 'no-back-view',
    probe: (d) => (d.backViewIndex < 0 ? 'no-back-view' : 'back-view-found'),
    analysis: buildSingleSymmetric(900, 480),
  },
  {
    id: 'two-view-front-back',
    label: 'separated symmetric front (left) + asymmetric center-seam back (right)',
    // Robust: the right-side asymmetric center-seam blob is the clear back.
    hardExpected: 'back-view-found',
    probe: (d) => (d.backViewIndex >= 0 ? 'back-view-found' : 'no-back-view'),
    analysis: buildFrontBack(900, 480),
  },
  {
    id: 'ambiguous-layout',
    label: 'two near-identical symmetric blobs — near-equal view scores',
    knownLimitation: 'Two symmetric front-like blobs give near-equal role scores; the classifier flags viewRoleReviewRequired so the TD confirms roles by hand. Which blob wins "back" here is not a stable contract.',
    probe: (d) => `reviewRequired=${d.viewRoleReviewRequired}`,
    analysis: buildAmbiguous(900, 480),
  },
  {
    id: 'three-view-positional-roles',
    label: 'front|back|inner panels are labeled by left-to-right position',
    // Robust (TD convention, ADR-0035): the panel order on a technical board is
    // always front_outer, back, front_inner left to right, so the classifier
    // assigns the three roles by centroidX order — no reliance on the fuzzy
    // back-vs-inner visual score that used to swap them.
    hardExpected: 'front_outer,back,front_inner',
    probe: (d) => (d.views || []).map(v => v.viewRole).join(','),
    analysis: buildThreeView(1350, 480),
  },
  {
    id: 'three-view-trust-position-no-review',
    label: 'a clean 3-panel board is not forced into the role-review dialog',
    // Position is authoritative, so a cleanly-split 3-panel board gets a
    // confident role assignment and does NOT raise viewRoleReviewRequired — the
    // TD is not prompted (ADR-0035 "skip it — trust position").
    hardExpected: 'no-review',
    probe: (d) => (d.viewRoleReviewRequired ? 'review-required' : 'no-review'),
    analysis: buildThreeView(1350, 480),
  },
  {
    id: 'three-view-tight-split',
    label: 'three tightly-spaced panels are split back into three views',
    // Robust: even when narrow gaps merge two panels into one over-wide box in
    // component grouping, splitWideViewBoxes must recover three view boxes so a
    // single-photo 3-view board (EvelynBliss) does not smear anchors across the
    // gap between panels.
    hardExpected: 'three-views',
    probe: (d) => ((d.views || []).length === 3 ? 'three-views' : `views=${(d.views||[]).length}`),
    analysis: buildThreeViewTight(1350, 480),
  },
];

runCases('View-role synthetic diagnostic matrix', cases, classifyViewRole, {
  guardLabel: 'view-role diagnostic',
});
