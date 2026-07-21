#!/usr/bin/env node
// Synthetic diagnostic matrix for POM 6 (cradle height at center front).
//
// POM 6's top anchor (cradle-cf-top) is seeded from the direct CF-seam
// detector (detection.cradleCfTop) — a roughly-horizontal cradle/cup-bottom
// seam approaching the center-front axis, with a band baseline below to
// project onto. When that direct detector misses BUT the bottom-cup cradle
// seam was found (detection.cradleCupTop, the POM 7 top), seed-anchors falls
// back to projecting that seam to the CF axis (cradleCfFromCupSeam) as a
// low-confidence, reviewRequired starting line. Only when BOTH are missing
// does POM 6 demote to REVIEW_ONLY.
//
// Like the POM 7 matrix:
// - hard guards fail only for clear regressions (drawing POM 6 with no real CF
//   cradle seam, or refusing to draw it when a clean one is present).
// - known weak spots are reported as LIMITATION so they can steer the next
//   detector improvement without turning CI red.
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

// Draw the common bra frame: two cup ellipses, chest line, band, CF vertical
// line, and side seams. Returns the drawing helpers + key rows so each case
// can add (or omit) the CF cradle seam / POM 7 line it wants to exercise.
function buildFrame(width, height) {
  const canvas = makeInkCanvas(width, height);
  const { setDark } = canvas;
  const cx = width / 2;
  const halfBox = Math.round(width * 0.14);
  const cupR = Math.min(halfBox, height * 0.16) * 0.85;
  const cupY = height * 0.40;
  const bandY = Math.round(height * 0.82);
  const bandThickness = Math.max(3, Math.round(height * 0.04));
  const chestY = Math.round(height * 0.30);
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
  for (let y = Math.round(height * 0.06); y <= bandY; y += 1) setDark(Math.round(cx), y);
  for (let y = chestY; y <= bandY + bandThickness; y += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      setDark(sideLX - dx, y);
      setDark(sideRX + dx, y);
    }
  }

  return { canvas, setDark, cx, halfBox, cupR, cupY, bandY, cupBottomY: Math.round(cupY + cupR) };
}

function pack(frame, engine) {
  const { canvas } = frame;
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

// A clear horizontal cradle/cup-bottom seam straddling the CF axis at the
// cup-bottom row, plus the band below (already drawn) to project POM 6's end.
function buildSolidCfSeam(width, height) {
  const frame = buildFrame(width, height);
  const { setDark, cx, halfBox, cupBottomY } = frame;
  const runHalf = Math.round(halfBox * 0.6);
  for (let x = cx - runHalf; x <= cx + runHalf; x += 1) {
    setDark(Math.round(x), cupBottomY);
    setDark(Math.round(x), cupBottomY + 1);
  }
  return pack(frame, 'pom6-diagnostic-solid-cf-seam');
}

// Cup outline + chest + band + CF line, but NO cradle seam near CF.
function buildNoCradle(width, height) {
  return pack(buildFrame(width, height), 'pom6-diagnostic-no-cradle');
}

// A tiny decorative mark on the CF axis at the cradle row: 3 columns wide,
// 3 rows tall. It clears the local ink-support floor (>=0.05) but is far too
// short to satisfy the seam-run gate (horizontal run <8, single-row run <5,
// and not dense enough for the denseLocalInk path) — so POM 6 must stay
// REVIEW_ONLY. A real cradle seam extends much farther across the axis.
function buildDecorativeTickCf(width, height) {
  const frame = buildFrame(width, height);
  const { setDark, cx, cupBottomY } = frame;
  for (let x = cx - 1; x <= cx + 1; x += 1) {
    for (let dy = 0; dy <= 2; dy += 1) setDark(Math.round(x), cupBottomY + dy);
  }
  return pack(frame, 'pom6-diagnostic-decorative-tick-cf');
}

// A solid off-axis POM 7 vertical line from the cup-bottom seam to the band,
// with NO horizontal cradle seam approaching the CF axis. The bottom-cup
// cradle seam (POM 7 / cradleCupTop) IS present, but POM 6's CF-seam detector
// finds nothing at the axis, so POM 6 stays REVIEW_ONLY. This is the target of
// a later seeding fallback: derive POM 6's CF cradle top from the POM 7 seam.
function buildWeakCfWithCradleCup(width, height) {
  const frame = buildFrame(width, height);
  const { setDark, cx, halfBox, cupBottomY, bandY } = frame;
  const pom7X = Math.round(cx + halfBox * 0.55);
  for (let y = cupBottomY - 2; y <= bandY + 1; y += 1) {
    for (let dx = -1; dx <= 1; dx += 1) setDark(pom7X + dx, y);
  }
  return pack(frame, 'pom6-diagnostic-weak-cf-with-cradlecup');
}

function classifyPom6(item) {
  const { detection, fixture } = runPipeline(pipeline, item.analysis, { id: item.id });
  const pom6 = pomRow(fixture, 6);
  const hasGeometry = !!(pom6 && pom6.start && pom6.end);
  const reason = detection.cradleCfTopMissingReason || (pom6 && pom6.uncertainty) || '';
  return {
    actual: pom6 && pom6.drawability,
    detail: `geometry=${hasGeometry ? 'yes' : 'no'}`,
    reason,
    notes: [
      `cradleCfTop: ${detection.cradleCfTop ? 'present' : 'absent'}`
        + ` (inkRatio=${detection.cradleCfTopInkRatio}, hRun=${detection.cradleCfTopSeamHorizontalRun}, singleRun=${detection.cradleCfTopSeamSingleRowRun})`,
      `cradleCupTop: ${detection.cradleCupTop ? 'present' : 'absent'}`,
    ],
  };
}

const cases = [
  {
    id: 'solid-cf-seam',
    label: 'clear horizontal cradle seam meeting CF axis + band below',
    hardExpected: 'DRAWABLE',
    analysis: buildSolidCfSeam(640, 480),
  },
  {
    id: 'no-cradle',
    label: 'cup outline + chest + band + CF line, no cradle seam near CF',
    hardExpected: 'REVIEW_ONLY',
    analysis: buildNoCradle(640, 480),
  },
  {
    id: 'decorative-tick-cf',
    label: 'tiny decorative mark near CF, too short for the seam-run gate',
    hardExpected: 'REVIEW_ONLY',
    analysis: buildDecorativeTickCf(640, 480),
  },
  {
    // Guards the POM 6 cradleCfFromCupSeam rescue: with no direct CF seam but a
    // detected bottom-cup cradle seam (cradleCupTop), POM 6's top is projected
    // to the CF axis so the row draws (low-confidence, reviewRequired) instead
    // of a hard REVIEW_ONLY demotion. Reverting the rescue flips this back.
    id: 'weak-cf-with-cradlecup',
    label: 'no direct CF seam, but the bottom-cup cradle seam (POM 7) is present',
    hardExpected: 'DRAWABLE',
    analysis: buildWeakCfWithCradleCup(640, 480),
  },
];

runCases('POM 6 synthetic diagnostic matrix', cases, classifyPom6, {
  guardLabel: 'POM 6 diagnostic',
});
