#!/usr/bin/env node
// Run Automatic Semantic ROI on all six pilot photos. Scores remain blocked
// until Oracle records are TD-confirmed; draft polygons are never treated as
// accuracy authority.

import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessApp, analyzeSeamFixture } from './headless-app.mjs';
import { scoreAutomaticRoiImage, scoreSemanticRoiPair } from './photo-stitch-roi-metrics.mjs';
import { validateSemanticRois } from './photo-stitch-roi-schema.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(appDir, 'scripts/groundtruth/photo-stitch');
const photoDir = path.join(appDir, 'demo/photos for seam detection');
const outputPath = path.join(appDir, 'demo/photo-stitch-roi-predictions.json');
let app;
let assertions = 0;
const check = (condition, message) => { if (!condition) throw new Error(message); assertions += 1; };

async function main() {
  const square = [{x:0.1,y:0.1},{x:0.4,y:0.1},{x:0.4,y:0.4},{x:0.1,y:0.4}];
  const same = scoreSemanticRoiPair(square, square, 96);
  const disjoint = scoreSemanticRoiPair(square, square.map(point => ({x:point.x+0.5,y:point.y+0.5})), 96);
  check(Math.abs(same.polygonIou - 1) < 1e-12 && same.meanBoundaryError === 0,
    'metric self-test: identical polygons must score IoU 1 and boundary error 0');
  check(disjoint.polygonIou === 0 && disjoint.missedCoverage === 1 && disjoint.excessCoverage === 1,
    'metric self-test: disjoint polygons must score IoU 0 and full coverage error');

  try { await access(photoDir); } catch {
    console.log('SKIP  photo-stitch-roi-pilot: private pilot photos are absent');
    return;
  }
  const fixtures = [];
  for (const name of (await readdir(corpusDir)).filter(name => name.endsWith('.json')).sort()) {
    const fixture = JSON.parse(await readFile(path.join(corpusDir, name), 'utf8'));
    validateSemanticRois(fixture.semanticRois, name);
    fixtures.push({ name, fixture });
  }
  check(fixtures.length === 6, `expected six fixtures, got ${fixtures.length}`);

  app = await launchHeadlessApp({ appDir, query: 'roi-pilot', profilePrefix: 'photo-stitch-roi-pilot-' });
  const { session } = app;

  const predictions = [];
  for (const { fixture } of fixtures) {
    const result = await analyzeSeamFixture(session, { relativePath: `demo/photos for seam detection/${fixture.image}` });
    check(result && result.contractVersion === 'photo-stitch-candidate/2', `${fixture.image}: runtime result missing`);
    check(result.inputClass?.value === 'product_photo' && result.analysisLane === 'product_photo',
      `${fixture.image}: pilot photo must stay in the product_photo lane`);
    predictions.push({ image: fixture.image, sourceSha256: fixture.sourceSha256, result });
    console.log(`  ${fixture.image.padEnd(5)} eligible=${String(result.inputEligible).padEnd(5)} rois=${result.automaticRois.length} candidates=${result.candidates.length} abstentions=${result.abstentions.length}`);
  }
  await writeFile(outputPath, `${JSON.stringify({ pipelineVersion:'auto-seam-candidate-v2', generatedAt:new Date().toISOString(), predictions }, null, 2)}\n`);

  const totalOracle = fixtures.reduce((sum, item) => sum + item.fixture.semanticRois.length, 0);
  const confirmedOracle = fixtures.reduce((sum, item) => sum + item.fixture.semanticRois.filter(roi => roi.source === 'td_confirmed').length, 0);
  if (confirmedOracle !== totalOracle) {
    console.log(`BLOCKED  Automatic ROI accuracy: ${confirmedOracle}/${totalOracle} Oracle records are td_confirmed; draft_pending_td is not scored`);
    console.log(`PASS  photo-stitch-roi-pilot structural/readiness   ${assertions} assertions ok`);
    return;
  }
  const scores = fixtures.map(({ fixture }) => {
    const prediction = predictions.find(item => item.image === fixture.image);
    return { image:fixture.image, ...scoreAutomaticRoiImage(fixture.semanticRois, prediction.result.automaticRois) };
  });
  console.log(JSON.stringify({ thresholds:'TBC — TD calibrated', scores }, null, 2));
  console.log(`PASS  photo-stitch-roi-pilot metrics   ${assertions} assertions ok`);
}

try { await main(); } catch (error) { process.exitCode = 1; console.error(`FAIL  photo-stitch-roi-pilot\n${error.stack || error}`); }
finally { await app?.close(); }
