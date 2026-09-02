#!/usr/bin/env node
// Auto Seam probe — the diagnostic every US-109 investigation reached for and
// used to rebuild as a throwaway. Runs the real runtime on one or more fixtures
// and prints, per zone/side, the full evidence vector (all corridor and
// edge-band features, not the 9-field subset the check script prints), the
// abstention reason, and optionally the drawn geometry in source pixels and
// the ROI corridor polygons. Read-only: it never asserts and never writes.
//
//   npm run auto-seam-probe -- synthetic
//   npm run auto-seam-probe -- "demo/photos for seam detection/image5.png" --zones=neckline,armhole --geometry
//   npm run auto-seam-probe -- "demo/photos for seam detection/photo4.png" --rois --fields=pathSupport,contourBindingFlipShare
//
// Options: --zones=a,b (default all) · --geometry (anchors in source px) ·
//          --rois (corridor polygons in source px) · --fields=a,b (evidence
//          subset; default all) · --json (one machine-readable object per fixture)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessApp, analyzeSeamFixture, readFixtureDataUrl } from './headless-app.mjs';
import { syntheticTechnicalFlatDataUrl } from './auto-seam-synthetic-fixture.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = name => args.includes(`--${name}`);
const zones = option('zones') ? new Set(option('zones').split(',')) : null;
const fields = option('fields') ? option('fields').split(',') : null;
const fixtures = args.filter(arg => !arg.startsWith('--'));
if (!fixtures.length) {
  console.error('usage: auto-seam-probe <fixture.png|synthetic> [...] [--zones=a,b] [--geometry] [--rois] [--fields=a,b] [--json]');
  process.exit(2);
}
let app;

const wants = zone => !zones || zones.has(zone);
const round3 = value => Number(value.toFixed(3));
const pick = evidence => Object.fromEntries(Object.entries(evidence)
  .filter(([key]) => !fields || fields.includes(key))
  .map(([key, value]) => [key, typeof value === 'number' ? round3(value) : value]));
const toPx = (point, size) => `(${Math.round(point.x * size.width)},${Math.round(point.y * size.height)})`;

async function main() {
  app = await launchHeadlessApp({ appDir, query: 'auto-seam-probe', profilePrefix: 'auto-seam-probe-' });
  const { session } = app;
  for (const fixture of fixtures) {
    const dataUrl = fixture === 'synthetic' ? syntheticTechnicalFlatDataUrl() : await readFixtureDataUrl(path.resolve(fixture));
    const result = await analyzeSeamFixture(session, { dataUrl });
    const size = result.diagnostics?.nativeRoiAnalysisSize || { width: 1, height: 1 };
    const rows = [];
    for (const candidate of result.candidates) {
      if (!wants(candidate.semanticZone)) continue;
      const geometry = candidate.geometry;
      rows.push({
        outcome: 'PASS', zone: candidate.semanticZone, side: candidate.side, geometrySource: candidate.geometrySource,
        ...(flag('geometry') ? { anchorsPx: [geometry.start, ...(geometry.points || []).map(p => p.point), geometry.end].map(p => toPx(p, size)) } : {}),
        evidence: pick(candidate.confidence),
      });
    }
    for (const abstention of result.abstentions) {
      if (abstention.scope !== 'zone' || !wants(abstention.zone)) continue;
      rows.push({ outcome: 'FAIL', zone: abstention.zone, side: abstention.side, code: abstention.code, reason: abstention.reason, evidence: abstention.evidence ? pick(abstention.evidence) : null });
    }
    const rois = flag('rois') ? result.automaticRois.filter(roi => wants(roi.zone)).map(roi => ({
      id: roi.id, seedSource: roi.seedSource, polygonPx: roi.polygon.map(p => toPx(p, size)),
    })) : null;
    const header = {
      fixture: fixture === 'synthetic' ? 'synthetic' : path.basename(fixture),
      inputClass: `${result.inputClass.value} (${result.inputClass.ruleId})`,
      lane: result.analysisLane, eligible: result.inputEligible,
      necklineSeedSource: result.diagnostics?.necklineSeedSource ?? null,
      rois: result.automaticRois.length, candidates: result.candidates.length, abstentions: result.abstentions.length,
      imageAbstentions: result.abstentions.filter(item => item.scope === 'image').map(item => `${item.code}: ${item.reason}`),
    };
    if (flag('json')) {
      console.log(JSON.stringify({ ...header, rows, rois }, null, 2));
      continue;
    }
    console.log(`=== ${header.fixture}  inputClass=${header.inputClass}  lane=${header.lane}  eligible=${header.eligible}  necklineSeed=${header.necklineSeedSource}  rois=${header.rois} candidates=${header.candidates} abstentions=${header.abstentions}`);
    for (const line of header.imageAbstentions) console.log(`  image abstention: ${line}`);
    for (const row of rows) {
      const head = `  ${row.outcome} ${row.zone.padEnd(14)} ${String(row.side).padEnd(9)}`;
      if (row.outcome === 'PASS') {
        console.log(`${head} ${row.geometrySource}${row.anchorsPx ? `  anchors ${row.anchorsPx.join(' ')}` : ''}`);
      } else {
        console.log(`${head} ${row.code} — ${row.reason}`);
      }
      if (row.evidence) console.log(`      ${JSON.stringify(row.evidence)}`);
    }
    if (rois) for (const roi of rois) console.log(`  ROI ${roi.id} [${roi.seedSource}] ${roi.polygonPx.join(' ')}`);
  }
}

try { await main(); } catch (error) { process.exitCode = 1; console.error(`FAIL  auto-seam-probe\n${error.stack || error}`); }
finally { await app?.close(); }
