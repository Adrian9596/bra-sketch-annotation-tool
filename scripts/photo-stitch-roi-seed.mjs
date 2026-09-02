#!/usr/bin/env node
// Deterministically seed review-only Oracle ROI polygons. This script never
// promotes a record to td_confirmed and never overwrites an existing ROI.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { semanticRoiId, semanticRoiIdentities } from './photo-stitch-roi-schema.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(appDir, 'scripts/groundtruth/photo-stitch');

const LEFT_TEMPLATES = Object.freeze({
  shoulder_strap: [
    { x: 0.13, y: 0.06 }, { x: 0.29, y: 0.06 }, { x: 0.34, y: 0.43 }, { x: 0.25, y: 0.47 }, { x: 0.18, y: 0.31 }, { x: 0.10, y: 0.16 },
  ],
  neckline: [
    { x: 0.26, y: 0.35 }, { x: 0.36, y: 0.40 }, { x: 0.50, y: 0.58 }, { x: 0.50, y: 0.66 }, { x: 0.42, y: 0.62 }, { x: 0.29, y: 0.49 }, { x: 0.21, y: 0.43 },
  ],
  armhole: [
    { x: 0.08, y: 0.27 }, { x: 0.17, y: 0.31 }, { x: 0.26, y: 0.46 }, { x: 0.22, y: 0.66 }, { x: 0.13, y: 0.70 }, { x: 0.05, y: 0.56 }, { x: 0.03, y: 0.39 },
  ],
  cup_edge: [
    { x: 0.16, y: 0.43 }, { x: 0.29, y: 0.39 }, { x: 0.44, y: 0.48 }, { x: 0.49, y: 0.62 }, { x: 0.44, y: 0.70 }, { x: 0.25, y: 0.69 }, { x: 0.12, y: 0.57 },
  ],
  cup_seam: [
    { x: 0.16, y: 0.48 }, { x: 0.25, y: 0.43 }, { x: 0.38, y: 0.47 }, { x: 0.47, y: 0.62 }, { x: 0.43, y: 0.69 }, { x: 0.29, y: 0.65 }, { x: 0.18, y: 0.58 },
  ],
  underbust_band: [
    { x: 0.07, y: 0.68 }, { x: 0.25, y: 0.67 }, { x: 0.50, y: 0.70 }, { x: 0.50, y: 0.82 }, { x: 0.27, y: 0.83 }, { x: 0.08, y: 0.80 },
  ],
  side_seam: [
    { x: 0.04, y: 0.52 }, { x: 0.14, y: 0.52 }, { x: 0.18, y: 0.79 }, { x: 0.08, y: 0.83 },
  ],
});

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}

function mapForAxis(points, side, axis) {
  const scale = Math.min(1, axis / 0.5, (1 - axis) / 0.5);
  return points.map(point => {
    const signed = point.x - 0.5;
    const x = side === 'left'
      ? axis + signed * scale
      : axis - signed * scale;
    return { x: clamp01(x), y: clamp01(point.y) };
  });
}

function seedRecord(zone, side, axis) {
  let polygon;
  if (zone === 'center_front') {
    polygon = [
      { x: clamp01(axis - 0.045), y: 0.48 },
      { x: clamp01(axis + 0.045), y: 0.48 },
      { x: clamp01(axis + 0.055), y: 0.81 },
      { x: clamp01(axis - 0.055), y: 0.81 },
    ];
  } else {
    polygon = mapForAxis(LEFT_TEMPLATES[zone], side, axis);
  }
  return {
    id: semanticRoiId(zone, side),
    zone,
    side,
    availability: 'available',
    polygon,
    source: 'draft_pending_td',
    reviewer: null,
    reviewedAt: null,
    unavailableReason: null,
  };
}

async function main() {
  const names = (await readdir(corpusDir)).filter(name => name.endsWith('.json')).sort();
  let changed = 0;
  for (const name of names) {
    const file = path.join(corpusDir, name);
    const fixture = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(fixture.semanticRois) && fixture.semanticRois.length) {
      console.log(`KEEP  ${name}: existing semanticRois (${fixture.semanticRois.length})`);
      continue;
    }
    const center = fixture.view?.centerAxis;
    const axis = Number.isFinite(center?.xTop) && Number.isFinite(center?.xBottom)
      ? (center.xTop + center.xBottom) / 2
      : 0.5;
    fixture.semanticRois = semanticRoiIdentities().map(({ zone, side }) => seedRecord(zone, side, axis));
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
    changed += 1;
    console.log(`SEED  ${name}: 15 draft_pending_td semantic ROIs`);
  }
  console.log(`DONE  changed ${changed}/${names.length} fixtures; no ROI was promoted to td_confirmed`);
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
