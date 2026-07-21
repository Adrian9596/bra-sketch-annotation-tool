#!/usr/bin/env node
// Junction / endpoint / corner detector tests (Phase 1, plan 2).
//
// Boots the bundled app.js in a Node VM (same DOM-stub approach as
// scripts/pipeline-tests.mjs) and drives the pure detectJunctions stage with
// synthetic masks whose topology is known exactly: a cross has one junction
// and four endpoints, an L has one corner, a rectangle has four, and so on.
// Runs on thin AND thick strokes so the Zhang-Suen thinning + valid-branch
// mitigation (doubled skeleton pixels on thick ink) is covered.
//
// No Chrome, no deps: node scripts/junction-tests.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

// ---- Recursive DOM stub (same shape as pipeline-tests.mjs) ----
function makeStub() {
  const target = function () { return makeStub(); };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () { /* empty */ };
      if (prop === Symbol.asyncIterator) return undefined;
      if (prop === 'then') return undefined;
      if (prop === 'length') return 0;
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
      if (prop === 'getBoundingClientRect') {
        return () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
      }
      return makeStub();
    },
    apply() { return makeStub(); },
    construct() { return makeStub(); },
    set() { return true; },
    has() { return false; },
  });
}

const documentStub = makeStub();
const windowStub = {
  document: documentStub,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() },
  location: { search: '', href: '', pathname: '' },
  prompt: () => null,
  confirm: () => false,
  alert() {},
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  BraMeasurementRules: undefined,
  __braAutoModeDebug: null,
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: windowStub.performance,
  URL, URLSearchParams,
  navigator: { userAgent: 'node-test' },
  Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float32Array, Float64Array,
  Map, Set, WeakMap, WeakSet, Promise,
  FreeOpenCVAPI: undefined,
  RealOpenCVAPI: undefined,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

windowStub.BraMeasurementRules = readRuleFixture();

const appSrc = readFileSync(path.join(appDir, 'app.js'), 'utf8');
try {
  vm.runInContext(appSrc, sandbox);
} catch (_initError) {
  // Expected: init() touches DOM that the stub doesn't model fully.
}

const debug = sandbox.window.__braAutoModeDebug;
const detectJunctions = debug && debug.pipeline && debug.pipeline.detectJunctions;
if (!detectJunctions) {
  console.error('FAIL: window.__braAutoModeDebug.pipeline.detectJunctions was not registered.');
  process.exit(1);
}

function readRuleFixture() {
  const version = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/version.json'), 'utf8'));
  const pomTemplate = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/pom-template.json'), 'utf8'));
  const anchorSchema = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/anchor-schema.json'), 'utf8'));
  const POM_TEMPLATE = {};
  for (const row of pomTemplate.rows) {
    POM_TEMPLATE[String(row.id)] = {
      desc: row.name,
      refL: row.refL == null ? null : row.refL,
      viewRole: row.placementViewRole || row.view,
      measurementView: row.view,
      requiredAnchors: row.requiredAnchors.slice(),
    };
  }
  return Object.freeze({
    POM_UNIT: version.pom_unit || 'in',
    POM_TEMPLATE,
    POM_PAIR_PRIMARIES: {},
    ANCHOR_SCHEMA: anchorSchema.anchors,
    AUTO_TEMPLATE_VERSION: version.template_version,
    AUTO_RULE_VERSION: version.rule_version,
  });
}

// ---- Mask builders ----
function emptyMask(w, h) {
  return new Uint8Array(w * h);
}
// Draw a stroke segment with the given thickness (square brush).
function drawSegment(mask, w, h, x1, y1, x2, y2, thickness) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2 + 1;
  const half = Math.floor((thickness || 1) / 2);
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const cx = Math.round(x1 + (x2 - x1) * t);
    const cy = Math.round(y1 + (y2 - y1) * t);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        const px = cx + dx, py = cy + dy;
        if (px >= 0 && py >= 0 && px < w && py < h) mask[py * w + px] = 1;
      }
    }
  }
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
  }
}

const W = 120, H = 120;

// ---- Test 1: empty mask ----
console.log('\nstage: empty mask');
{
  const res = detectJunctions(emptyMask(W, H), W, H);
  check('no points on an empty mask', res.points.length === 0,
    `points=${res.points.length}`);
  check('summary is all zero',
    res.summary.junctions === 0 && res.summary.endpoints === 0 && res.summary.corners === 0,
    JSON.stringify(res.summary));
}

// ---- Test 2: straight line — endpoints only ----
console.log('\nstage: straight horizontal line');
{
  const mask = emptyMask(W, H);
  drawSegment(mask, W, H, 20, 60, 100, 60, 1);
  const res = detectJunctions(mask, W, H);
  check('no junctions', res.summary.junctions === 0, JSON.stringify(res.summary));
  check('exactly 2 endpoints', res.summary.endpoints === 2, JSON.stringify(res.summary));
  check('no corners', res.summary.corners === 0, JSON.stringify(res.summary));
  const xs = res.points.filter(p => p.type === 'endpoint').map(p => p.xPx).sort((a, b) => a - b);
  check('endpoints sit at the line tips (±3px)',
    xs.length === 2 && Math.abs(xs[0] - 20) <= 3 && Math.abs(xs[1] - 100) <= 3,
    `xs=${JSON.stringify(xs)}`);
}

// ---- Test 3: cross — one junction, four endpoints ----
console.log('\nstage: thin cross');
{
  const mask = emptyMask(W, H);
  drawSegment(mask, W, H, 60, 20, 60, 100, 1);
  drawSegment(mask, W, H, 20, 60, 100, 60, 1);
  const res = detectJunctions(mask, W, H);
  check('exactly 1 junction', res.summary.junctions === 1, JSON.stringify(res.summary));
  check('exactly 4 endpoints', res.summary.endpoints === 4, JSON.stringify(res.summary));
  const j = res.points.find(p => p.type === 'junction');
  check('junction sits at the crossing (±3px)',
    j && Math.abs(j.xPx - 60) <= 3 && Math.abs(j.yPx - 60) <= 3,
    j ? `(${j.xPx}, ${j.yPx})` : 'missing');
  check('junction has ≥4 branches (X crossing)',
    j && j.neighborCount >= 4, j ? `branches=${j.neighborCount}` : 'missing');
  check('normalized coords match pixel coords',
    j && Math.abs(j.x - j.xPx / W) < 1e-4 && Math.abs(j.y - j.yPx / H) < 1e-4,
    j ? `x=${j.x} xPx=${j.xPx}` : 'missing');
}

// ---- Test 4: THICK cross — thinning + valid-branch mitigation ----
console.log('\nstage: thick cross (5px strokes)');
{
  const mask = emptyMask(W, H);
  drawSegment(mask, W, H, 60, 20, 60, 100, 5);
  drawSegment(mask, W, H, 20, 60, 100, 60, 5);
  const res = detectJunctions(mask, W, H);
  check('thick strokes still yield exactly 1 junction',
    res.summary.junctions === 1, JSON.stringify(res.summary));
  check('thick strokes still yield 4 endpoints',
    res.summary.endpoints === 4, JSON.stringify(res.summary));
  check('thinning ran at least once',
    res.summary.thinningIterations >= 1,
    `iterations=${res.summary.thinningIterations}`);
}

// ---- Test 5: T shape — 3-branch junction ----
console.log('\nstage: T shape');
{
  const mask = emptyMask(W, H);
  drawSegment(mask, W, H, 20, 40, 100, 40, 1);
  drawSegment(mask, W, H, 60, 40, 60, 100, 1);
  const res = detectJunctions(mask, W, H);
  const j = res.points.find(p => p.type === 'junction');
  check('exactly 1 junction', res.summary.junctions === 1, JSON.stringify(res.summary));
  check('exactly 3 endpoints', res.summary.endpoints === 3, JSON.stringify(res.summary));
  check('junction reports 3 branches', j && j.neighborCount === 3,
    j ? `branches=${j.neighborCount}` : 'missing');
}

// ---- Test 6: L shape — corner, no junction ----
console.log('\nstage: L shape (90° bend)');
{
  const mask = emptyMask(W, H);
  drawSegment(mask, W, H, 30, 30, 30, 90, 1);
  drawSegment(mask, W, H, 30, 90, 90, 90, 1);
  const res = detectJunctions(mask, W, H);
  check('no junctions on an L', res.summary.junctions === 0, JSON.stringify(res.summary));
  check('exactly 2 endpoints', res.summary.endpoints === 2, JSON.stringify(res.summary));
  check('at least 1 corner', res.summary.corners >= 1, JSON.stringify(res.summary));
  const c = res.points.filter(p => p.type === 'corner')
    .sort((a, b) => Math.hypot(a.xPx - 30, a.yPx - 90) - Math.hypot(b.xPx - 30, b.yPx - 90))[0];
  check('strongest corner sits at the bend (±4px)',
    c && Math.hypot(c.xPx - 30, c.yPx - 90) <= 4,
    c ? `(${c.xPx}, ${c.yPx})` : 'missing');
  check('corner interior angle ≈ 90° (60°..120°)',
    c && c.angle >= 60 && c.angle <= 120,
    c ? `angle=${c.angle}` : 'missing');
}

// ---- Test 7: rectangle outline — 4 corners, closed path ----
console.log('\nstage: rectangle outline');
{
  const mask = emptyMask(W, H);
  drawSegment(mask, W, H, 30, 30, 90, 30, 1);
  drawSegment(mask, W, H, 90, 30, 90, 80, 1);
  drawSegment(mask, W, H, 90, 80, 30, 80, 1);
  drawSegment(mask, W, H, 30, 80, 30, 30, 1);
  const res = detectJunctions(mask, W, H);
  check('closed rectangle has no endpoints', res.summary.endpoints === 0,
    JSON.stringify(res.summary));
  check('no junctions', res.summary.junctions === 0, JSON.stringify(res.summary));
  check('exactly 4 corners (merge kills duplicates)', res.summary.corners === 4,
    JSON.stringify(res.summary));
}

// ---- Test 8: merge radius — nothing closer than 3px survives ----
console.log('\nstage: merge invariant');
{
  const mask = emptyMask(W, H);
  drawSegment(mask, W, H, 60, 20, 60, 100, 3);
  drawSegment(mask, W, H, 20, 60, 100, 60, 3);
  drawSegment(mask, W, H, 20, 20, 100, 100, 3);
  const res = detectJunctions(mask, W, H);
  let tooClose = null;
  for (let i = 0; i < res.points.length && !tooClose; i += 1) {
    for (let k = i + 1; k < res.points.length; k += 1) {
      const a = res.points[i], b = res.points[k];
      if (Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx) <= 3) {
        tooClose = `${a.type}(${a.xPx},${a.yPx}) vs ${b.type}(${b.xPx},${b.yPx})`;
        break;
      }
    }
  }
  check('no two surviving points within the merge radius', tooClose === null, tooClose || '');
  check('point cap respected', res.points.length <= 400, `points=${res.points.length}`);
  for (const p of res.points) {
    if (!(p.confidence > 0 && p.confidence <= 1)) {
      check('confidence in (0, 1]', false, `${p.type} confidence=${p.confidence}`);
      break;
    }
  }
}

// ---- Summary ----
console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('junction-tests passed');
