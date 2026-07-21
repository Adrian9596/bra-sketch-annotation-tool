#!/usr/bin/env node
// Synthetic diagnostic matrix for POM 7.
//
// This is intentionally separate from pipeline-tests:
// - hard guards fail only for clear regressions, such as drawing POM 7 when
//   no vertical POM 7 ink exists.
// - known weak spots are reported as LIMITATION so they can guide the next
//   detector improvement without making CI red.
//
// The headless VM machinery (DOM stub, rule fixture, pipeline load, ink
// canvas, staged pipeline run, and the PASS/FAIL/LIMITATION reporter) lives in
// scripts/lib/synthetic-detection.mjs and is shared with the POM 6, POM 14,
// and view-role diagnostic suites.

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

function buildPom7Fixture(width, height, opts = {}) {
  const { mask, stats, setDark } = makeInkCanvas(width, height);
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
    setDark(xL, yL);
    setDark(xL, yL + 1);
    setDark(xR, yL);
    setDark(xR, yL + 1);
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

  const cupBottomY = Math.round(cupY + cupR);
  const pom7X = Math.round(cx + halfBox * (opts.xFactor ?? 0.55));
  if (opts.vertical === 'solid') {
    for (let y = cupBottomY - 2; y <= bandY + 1; y += 1) {
      for (let dx = -1; dx <= 1; dx += 1) setDark(pom7X + dx, y);
    }
  } else if (opts.vertical === 'weak-dashed') {
    // Dash gap controls duty cycle: a 2px dash every `dashGap` rows gives a
    // continuous colRatio of ~2/dashGap. gap 8 -> ~0.25 (a real dashed line,
    // above the dashed-guide floor of 0.18); gap 12 -> ~0.17 (below the floor,
    // genuinely ambiguous). Both still span every segment.
    const dashGap = opts.dashGap ?? 5;
    for (let y = cupBottomY - 2; y <= bandY + 1; y += dashGap) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) setDark(pom7X + dx, y + dy);
      }
    }
  } else if (opts.vertical === 'decorative-short') {
    const yStart = cupBottomY + Math.round((bandY - cupBottomY) * 0.25);
    const yEnd = cupBottomY + Math.round((bandY - cupBottomY) * 0.45);
    for (let y = yStart; y <= yEnd; y += 1) {
      for (let dx = -1; dx <= 1; dx += 1) setDark(pom7X + dx, y);
    }
  }

  return {
    engine: `pom7-diagnostic-${opts.vertical || 'absent'}`,
    width,
    height,
    total: width * height,
    mask,
    stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

function classifyPom7(item) {
  const { detection, fixture } = runPipeline(pipeline, item.analysis, { id: item.id });
  const pom7 = pomRow(fixture, 7);
  const hasGeometry = !!(pom7 && pom7.start && pom7.end);
  const reason = detection.cradleCupMissingReason || (pom7 && pom7.uncertainty) || '';
  // Assert drawability AND acceptance tier together: since ADR 0022 a case
  // may be DRAWABLE via 'strong' (vertical guide), 'seam' (pattern 3),
  // 'guide' (sparse dashes, ADR 0021), or 'arc' (traced cup-bottom
  // structure, ADR 0022). A regression that promotes weak evidence into a
  // TRUSTED tier (which would feed the cupModel) flips the tier suffix and
  // fails the hard guard even though drawability looks unchanged.
  const tier = detection.cradleCupTier || 'none';
  return {
    actual: `${pom7 && pom7.drawability}@${tier}`,
    detail: `geometry=${hasGeometry ? 'yes' : 'no'}`,
    reason,
  };
}

const cases = [
  {
    id: 'solid-present',
    label: 'solid POM 7 vertical line',
    hardExpected: 'DRAWABLE@strong',
    analysis: buildPom7Fixture(640, 480, { vertical: 'solid' }),
  },
  {
    // Since ADR 0022 a sketch with NO drawn POM 7 line still drafts: the
    // traced cup-bottom arc commits at tier 'arc' (low-confidence +
    // reviewRequired, never fed to the cupModel). The hard guard here is the
    // TIER: if this case ever reports 'seam'/'strong'/'guide', structure ink
    // is being promoted into a trusted tier — that is the real regression.
    id: 'absent-cup-outline',
    label: 'cup outline + band, no POM 7 line — arc tier draws it for review',
    hardExpected: 'DRAWABLE@arc',
    analysis: buildPom7Fixture(640, 480, {}),
  },
  {
    // A short decorative tick must never be accepted as a guide or seam.
    // With ADR 0022 the case still drafts — but via the cup-bottom arc, with
    // the tick contributing nothing. Tier 'guide'/'seam' here = regression.
    id: 'decorative-short',
    label: 'short decorative vertical ink — ignored; arc tier draws for review',
    hardExpected: 'DRAWABLE@arc',
    analysis: buildPom7Fixture(640, 480, { vertical: 'decorative-short' }),
  },
  {
    // Locks in that a MODERATE dashed line (dash gap ~5px, ~40% duty) is
    // detected: its continuous colRatio clears the strong-guide threshold
    // (colMinRatio) so verticalGuideStrong fires. A regression that stopped
    // detecting moderate dashes would flip this to a weaker tier.
    id: 'moderate-dashed-present',
    label: 'moderate dashed POM 7 line (gap 5, clears the strong-guide threshold)',
    hardExpected: 'DRAWABLE@strong',
    analysis: buildPom7Fixture(640, 480, { vertical: 'weak-dashed', dashGap: 5 }),
  },
  {
    // Sparse dashes (gap >= ~8px) have a continuous colRatio below the
    // strong-guide floor but hit every vertical segment. Since US-013 / ADR
    // 0021 they commit at tier 'guide' (low-confidence + reviewRequired) and
    // are NEVER fed to the cupModel — the B3 coupling that forced the
    // 2026-07-09 revert of the first prototype is structurally closed.
    id: 'sparse-dashed-present',
    label: 'sparse dashed POM 7 line (gap 8) — guide tier draws it for review',
    hardExpected: 'DRAWABLE@guide',
    analysis: buildPom7Fixture(640, 480, { vertical: 'weak-dashed', dashGap: 8 }),
  },
  {
    // Locks in that a real POM 7 line sitting close to the side seam is still
    // detected — a present vertical guide exempts it from the near-side reject.
    id: 'near-side-present',
    label: 'real POM 7 line close to side seam',
    hardExpected: 'DRAWABLE@strong',
    analysis: buildPom7Fixture(640, 480, { vertical: 'solid', xFactor: 0.86 }),
  },
];

runCases('POM 7 synthetic diagnostic matrix', cases, classifyPom7, {
  guardLabel: 'POM 7 diagnostic',
});
