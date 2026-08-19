#!/usr/bin/env node
// Headless-Chrome-free unit tests for the pure detection pipeline.
//
// Loads the bundled app.js into a vm sandbox with DOM stubs lenient enough for
// state.js/manual-tools.js top-level code to complete. The pipeline is
// registered on window.__braAutoModeDebug.pipeline before init() runs, so
// init()'s DOM failure (caught below) doesn't matter.
//
// Each test feeds a stage a fixed synthetic input and asserts on the returned
// shape + per-stage timing.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

// ---- Recursive DOM stub: any access returns a chainable callable stub ----
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
  // populated from auto_mode_rules/*.json below
  BraMeasurementRules: undefined,
  // populated by app.js eval below
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
  // Stub the OpenCV adapters away so the pipeline uses the pure legacy path.
  FreeOpenCVAPI: undefined,
  RealOpenCVAPI: undefined,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// Step 1: register window.BraMeasurementRules so the browser JSON loader is
// bypassed in this DOM-free VM.
windowStub.BraMeasurementRules = readRuleFixture();

// Step 2: load app.js. init() will fail on DOM access, but the pipeline is
// registered on window.__braAutoModeDebug before init() runs.
const appSrc = readFileSync(path.join(appDir, 'app.js'), 'utf8');
try {
  vm.runInContext(appSrc, sandbox);
} catch (_initError) {
  // Expected: init() touches DOM that the stub doesn't model fully.
}

const debug = sandbox.window.__braAutoModeDebug;
const pipeline = debug && debug.pipeline;
if (!pipeline) {
  console.error('FAIL: window.__braAutoModeDebug.pipeline was not registered.');
  process.exit(1);
}

function readRuleFixture() {
  const version = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/version.json'), 'utf8'));
  const pomTemplate = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/pom-template.json'), 'utf8'));
  const anchorSchema = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/anchor-schema.json'), 'utf8'));
  const POM_TEMPLATE = {};
  const POM_PAIR_PRIMARIES = {};
  for (const row of pomTemplate.rows) {
    POM_TEMPLATE[String(row.id)] = {
      desc: row.name,
      refL: row.refL == null ? null : row.refL,
      viewRole: row.placementViewRole || row.view,
      measurementView: row.view,
      requiredAnchors: row.requiredAnchors.slice(),
    };
    if (Array.isArray(row.optionalAnchors) && row.optionalAnchors.length) {
      POM_TEMPLATE[String(row.id)].optionalAnchors = row.optionalAnchors.slice();
    }
    if (row.pairing && row.pairing.role === 'primary') {
      POM_PAIR_PRIMARIES[String(row.id)] = {
        partner: String(row.pairing.partner),
        desc: row.pairing.groupName || row.name,
        primaryLabel: row.pairing.primaryLabel || 'Primary',
        secondaryLabel: row.pairing.secondaryLabel || 'Secondary',
      };
    }
  }
  return Object.freeze({
    POM_UNIT: version.pom_unit || 'in',
    POM_TEMPLATE,
    POM_PAIR_PRIMARIES,
    ANCHOR_SCHEMA: anchorSchema.anchors,
    AUTO_TEMPLATE_VERSION: version.template_version,
    AUTO_RULE_VERSION: version.rule_version,
  });
}

// ---- Test fixtures ----
// Build a synthetic ink mask shaped like a generic torso: a vertically
// symmetric blob with a strong horizontal band near the bottom and a fainter
// chest line in the upper-middle. Coordinates match what the pure pipeline
// expects (Uint8Array of 0/1 per pixel, row-major).
function buildSyntheticInkAnalysis(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: width, minY: height, maxX: -1, maxY: -1,
    colDark: new Uint32Array(width),
    rowDark: new Uint32Array(height),
  };

  const cx = width / 2;
  // Torso silhouette: two ellipses for cups + a rectangle below for the band.
  const cupR = Math.min(width, height) * 0.18;
  const cupY = height * 0.40;
  const bandY = Math.round(height * 0.82);
  const bandThickness = Math.max(3, Math.round(height * 0.04));
  const chestY = Math.round(height * 0.30);

  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (mask[p]) return;
    mask[p] = 1;
    stats.count += 1;
    if (x < stats.minX) stats.minX = x;
    if (y < stats.minY) stats.minY = y;
    if (x > stats.maxX) stats.maxX = x;
    if (y > stats.maxY) stats.maxY = y;
    stats.colDark[x] += 1;
    stats.rowDark[y] += 1;
  };

  // Cup outlines (left + right)
  for (let theta = 0; theta < Math.PI * 2; theta += 0.01) {
    const xL = Math.round(cx - cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    const yL = Math.round(cupY + Math.sin(theta) * cupR);
    setDark(xL, yL);
    const xR = Math.round(cx + cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    setDark(xR, yL);
  }
  // Chest line: thin horizontal across the cup zone
  const chestSpan = Math.round(width * 0.55);
  for (let x = Math.round(cx - chestSpan / 2); x <= Math.round(cx + chestSpan / 2); x += 1) {
    setDark(x, chestY);
  }
  // Band: thick horizontal across the bottom
  const bandSpan = Math.round(width * 0.7);
  for (let dy = 0; dy < bandThickness; dy += 1) {
    for (let x = Math.round(cx - bandSpan / 2); x <= Math.round(cx + bandSpan / 2); x += 1) {
      setDark(x, bandY + dy);
    }
  }
  // CF axis: vertical line down center
  for (let y = Math.round(height * 0.06); y <= bandY; y += 1) setDark(Math.round(cx), y);

  return {
    engine: 'synthetic-test-fixture',
    width, height, total,
    mask,
    stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

function buildSyntheticNoApexInkAnalysis(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: width, minY: height, maxX: -1, maxY: -1,
    colDark: new Uint32Array(width),
    rowDark: new Uint32Array(height),
  };
  const cx = Math.round(width / 2);
  const chestY = Math.round(height * 0.34);
  const bandY = Math.round(height * 0.82);
  const leftX = Math.round(width * 0.24);
  const rightX = Math.round(width * 0.76);

  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (mask[p]) return;
    mask[p] = 1;
    stats.count += 1;
    if (x < stats.minX) stats.minX = x;
    if (y < stats.minY) stats.minY = y;
    if (x > stats.maxX) stats.maxX = x;
    if (y > stats.maxY) stats.maxY = y;
    stats.colDark[x] += 1;
    stats.rowDark[y] += 1;
  };

  // A simple strapless/front-panel sketch: strong chest/band/side/CF signals,
  // but no shoulder-strap-to-cup joining seam in the upper cup zone.
  for (let x = leftX; x <= rightX; x += 1) {
    setDark(x, chestY);
    setDark(x, bandY);
    setDark(x, bandY + 1);
    setDark(x, bandY + 2);
  }
  for (let y = Math.round(height * 0.10); y <= bandY; y += 1) {
    setDark(cx, y);
  }
  for (let y = chestY; y <= bandY; y += 1) {
    setDark(leftX, y);
    setDark(rightX, y);
  }

  return {
    engine: 'synthetic-no-apex-fixture',
    width, height, total,
    mask,
    stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

// Synthetic torso with a CRADLE/cup-bottom seam. Same silhouette as the base
// fixture, plus a strong horizontal cradle line at ~62% bbox height that
// crosses the CF axis. Drives the POM 6 PRESENT case (cradle-cf-top seeded).
function buildSyntheticCradleInkAnalysis(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: width, minY: height, maxX: -1, maxY: -1,
    colDark: new Uint32Array(width),
    rowDark: new Uint32Array(height),
  };

  const cx = width / 2;
  const cupR = Math.min(width, height) * 0.18;
  const cupY = height * 0.40;
  const bandY = Math.round(height * 0.82);
  const bandThickness = Math.max(3, Math.round(height * 0.04));
  const chestY = Math.round(height * 0.30);
  const cradleY = Math.round(height * 0.66);
  const cradleThickness = Math.max(2, Math.round(height * 0.015));

  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (mask[p]) return;
    mask[p] = 1;
    stats.count += 1;
    if (x < stats.minX) stats.minX = x;
    if (y < stats.minY) stats.minY = y;
    if (x > stats.maxX) stats.maxX = x;
    if (y > stats.maxY) stats.maxY = y;
    stats.colDark[x] += 1;
    stats.rowDark[y] += 1;
  };

  for (let theta = 0; theta < Math.PI * 2; theta += 0.01) {
    const xL = Math.round(cx - cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    const yL = Math.round(cupY + Math.sin(theta) * cupR);
    setDark(xL, yL);
    const xR = Math.round(cx + cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    setDark(xR, yL);
  }
  const chestSpan = Math.round(width * 0.55);
  for (let x = Math.round(cx - chestSpan / 2); x <= Math.round(cx + chestSpan / 2); x += 1) {
    setDark(x, chestY);
  }
  // Cradle / cup-bottom seam — long horizontal across the cup zone, crosses
  // the CF axis. Multi-row thickness so the row peak beats noise + chest.
  const cradleSpan = Math.round(width * 0.60);
  for (let dy = 0; dy < cradleThickness; dy += 1) {
    for (let x = Math.round(cx - cradleSpan / 2); x <= Math.round(cx + cradleSpan / 2); x += 1) {
      setDark(x, cradleY + dy);
    }
  }
  const bandSpan = Math.round(width * 0.7);
  for (let dy = 0; dy < bandThickness; dy += 1) {
    for (let x = Math.round(cx - bandSpan / 2); x <= Math.round(cx + bandSpan / 2); x += 1) {
      setDark(x, bandY + dy);
    }
  }
  for (let y = Math.round(height * 0.06); y <= bandY; y += 1) setDark(Math.round(cx), y);

  return {
    engine: 'synthetic-cradle-fixture',
    width, height, total,
    mask,
    stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

// ---- Assertions ----
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
  }
}

function makeValidationFixture() {
  const rows = [];
  const point = (x, y) => ({ x, y });
  const template = windowStub.BraMeasurementRules.POM_TEMPLATE;
  // 1..18: the fixture must cover the full core range or validateAutoFixture's
  // per-POM presence check (ADR 0032) reports the missing rows as failures.
  for (let n = 1; n <= 18; n += 1) {
    const pom = String(n);
    const row = {
      fixtureId: 'test-' + pom,
      pom,
      type: 'straight',
      style: 'solid',
      arrowType: 'double',
      viewRole: template[pom].viewRole,
      start: point(0.2, 0.2 + n * 0.01),
      end: point(0.4, 0.2 + n * 0.01),
      drawability: 'DRAWABLE',
      confidence: 'medium',
      proposedStartLandmark: 'test-a',
      proposedEndLandmark: 'test-b',
      reason: 'validation test row',
    };
    if (pom === '2' || pom === '4') row.style = 'dashed';
    if (pom === '6' || pom === '7' || pom === '8') {
      row.start = point(0.3 + n * 0.01, 0.2);
      row.end = point(0.3 + n * 0.01, 0.5);
    }
    if (pom === '14') {
      row.type = 'curved';
      row.control1 = point(0.24, 0.04);
      row.control2 = point(0.34, 0.08);
      row.confidence = 'low';
    }
    if (pom === '9' || pom === '10') row.sharedAnchorFamily = 'test-cup';
    rows.push(row);
  }
  return { annotations: rows };
}

function cloneFixture(fixture) {
  return JSON.parse(JSON.stringify(fixture));
}

function detectionWithViews(roles) {
  return {
    views: roles.map((viewRole, index) => ({ viewRole, role: viewRole, index })),
    viewBoxes: roles.map((viewRole, index) => ({ viewRole, role: viewRole, index })),
  };
}

// ---- Test 1: pixelsToLegacyInkAnalysis on synthetic pixels ----
// Build a tiny grayscale bitmap (RGBA): a horizontal black bar on a white field.
// The stage should classify the bar pixels as ink.
console.log('\nstage: pixelsToLegacyInkAnalysis');
{
  const w = 96, h = 64;
  const pixels = new Uint8ClampedArray(w * h * 4);
  // Paint everything white first.
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = 255;
  }
  // Paint a horizontal black bar across rows 40..44.
  for (let y = 40; y <= 44; y += 1) {
    for (let x = 10; x <= 85; x += 1) {
      const o = (y * w + x) * 4;
      pixels[o] = pixels[o + 1] = pixels[o + 2] = 0;
    }
  }

  const t0 = Date.now();
  const result = pipeline.pixelsToLegacyInkAnalysis(pixels, w, h);
  const ms = Date.now() - t0;

  check('returns mask of correct length', result.mask && result.mask.length === w * h);
  check('count > 0 (ink found)', result.stats.count > 0, `count=${result.stats.count}`);
  check('bar row 42 has ink', result.mask[42 * w + 50] === 1);
  check('white row 0 has no ink', result.mask[0 * w + 50] === 0);
  check('threshold returned', typeof result.threshold === 'number');
  console.log(`       (${ms} ms on ${w}x${h})`);
}

console.log('\nstage: validateAutoFixture view-role contract');
{
  check('validateAutoFixture is exposed on the pipeline', typeof pipeline.validateAutoFixture === 'function');
  const fixture = makeValidationFixture();
  const baseline = pipeline.validateAutoFixture(fixture, detectionWithViews(['front_outer', 'back']));
  check('baseline fixture passes structural validation', baseline.status === 'pass', JSON.stringify(baseline));
  const wrongView = cloneFixture(fixture);
  wrongView.annotations.find(row => row.pom === '11').viewRole = 'front_outer';
  const result = pipeline.validateAutoFixture(wrongView, detectionWithViews(['front_outer', 'back']));
  check('wrong-view POM fails validation', result.status === 'fail', JSON.stringify(result));
  check('wrong-view failure names the expected role',
    result.errors.some(msg => /POM 11: expected viewRole back, got front_outer/.test(msg)),
    JSON.stringify(result.errors));
}

// ---- Test 2: detectSketchFromInkAnalysis on synthetic torso ----
console.log('\nstage: detectSketchFromInkAnalysis (full pure pipeline)');
{
  const W = 256, H = 384;
  const analysis = buildSyntheticInkAnalysis(W, H);
  const t0 = Date.now();
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });
  const ms = Date.now() - t0;

  check('bbox present', detection && detection.bbox && detection.bbox.width > 0);
  // axisX is the symmetry axis of the primary view, not of the whole image.
  // With multi-component synthetic input the pipeline picks one component as
  // primary, so we just assert the output is a valid normalized coordinate.
  check('axisX is a normalized coordinate', detection.axisX >= 0 && detection.axisX <= 1,
    `axisX=${detection.axisX}`);
  check('bandY is in lower half', detection.bandY > 0.55 && detection.bandY < 0.95,
    `bandY=${detection.bandY}`);
  check('stageTimingsMs object present', detection.stageTimingsMs
    && typeof detection.stageTimingsMs === 'object');
  const expectedStages = [
    'inkMaskIngest',
    'connectedComponents',
    'viewBoxes',
    'centerAxis',
    'horizontalFeatures',
    'verticalFeatures',
    'apexStrap',
    'innerCupAndSideTop',
    'frontInkEndpoints',
    'backFeatures',
    'confidence',
    'assembleDetection',
  ];
  for (const stage of expectedStages) {
    check(`stage timing recorded: ${stage}`,
      detection.stageTimingsMs && typeof detection.stageTimingsMs[stage] === 'number',
      `value=${detection.stageTimingsMs && detection.stageTimingsMs[stage]}`);
  }
  console.log(`       (${ms} ms on ${W}x${H} synthetic torso)`);
  console.log('       per-stage timings (ms):',
    JSON.stringify(detection.stageTimingsMs, null, 0));
}

// ---- Test 3: CV debug capture on synthetic torso ----
// When { debug: true } is passed, the pipeline must attach a `debug` object
// covering the locals a TD needs to diagnose detection failures: thresholds,
// detection params, components, view boxes, chosen row/col landmarks, and
// per-stage timing. Default detection (no opts.debug) must NOT include it
// so the production payload stays small.
console.log('\nstage: detectSketchFromInkAnalysis CV debug capture');
{
  const W = 256, H = 384;
  const baseline = pipeline.detectSketchFromInkAnalysis(
    buildSyntheticInkAnalysis(W, H),
    { cv: null }
  );
  check('debug field absent by default', baseline.debug == null,
    `baseline.debug=${baseline.debug != null}`);

  const detection = pipeline.detectSketchFromInkAnalysis(
    buildSyntheticInkAnalysis(W, H),
    { cv: null, debug: true }
  );

  const debug = detection.debug;
  check('debug object attached when opts.debug=true', debug && typeof debug === 'object');
  if (debug) {
    check('debug.version is 1', debug.version === 1);
    check('debug.sampleWidth/Height match input',
      debug.sampleWidth === W && debug.sampleHeight === H,
      `sampleWidth=${debug.sampleWidth} sampleHeight=${debug.sampleHeight}`);
    check('debug.thresholds populated',
      debug.thresholds
        && typeof debug.thresholds.ink === 'number'
        && typeof debug.thresholds.luminance === 'number',
      `thresholds=${JSON.stringify(debug.thresholds)}`);
    check('debug.detectionParams includes learned-detector keys',
      debug.detectionParams
        && typeof debug.detectionParams.bandSearchStartRatio === 'number'
        && typeof debug.detectionParams.bandPreferredRatio === 'number'
        && typeof debug.detectionParams.rowNoiseMultiplier === 'number'
        && typeof debug.detectionParams.colNoiseMultiplier === 'number',
      `detectionParams=${JSON.stringify(debug.detectionParams)}`);
    check('debug.components has count + kept array',
      debug.components
        && typeof debug.components.componentCount === 'number'
        && Array.isArray(debug.components.kept));
    check('debug.viewBoxes is an array',
      Array.isArray(debug.viewBoxes),
      `viewBoxes=${typeof debug.viewBoxes}`);
    check('debug.primary has axisPx + symmetry',
      debug.primary
        && typeof debug.primary.axisPx === 'number'
        && typeof debug.primary.symmetry === 'number',
      `primary=${JSON.stringify(debug.primary)}`);
    check('debug.rows surfaces band/chest/cradle picks',
      debug.rows
        && typeof debug.rows.bandRow === 'number'
        && typeof debug.rows.bandEdgeRow === 'number'
        && 'chestRow' in debug.rows
        && 'cradleRow' in debug.rows,
      `rows keys=${debug.rows ? Object.keys(debug.rows).join(',') : 'none'}`);
    check('debug.cols surfaces side seam picks',
      debug.cols
        && 'sideLeftCol' in debug.cols
        && 'sideRightCol' in debug.cols
        && typeof debug.cols.noiseFloor === 'number',
      `cols keys=${debug.cols ? Object.keys(debug.cols).join(',') : 'none'}`);
    check('debug.confidence cloned',
      debug.confidence && typeof debug.confidence === 'object');
    check('debug.stageTimingsMs covers all stages',
      debug.stageTimingsMs
        && typeof debug.stageTimingsMs.confidence === 'number'
        && typeof debug.stageTimingsMs.assembleDetection === 'number');
  }
}

// ---- Test 4: no-apex styles should not fabricate apex anchors ------------
console.log('\nstage: detectSketchFromInkAnalysis no-apex style');
{
  const W = 256, H = 384;
  const detection = pipeline.detectSketchFromInkAnalysis(
    buildSyntheticNoApexInkAnalysis(W, H),
    { cv: null, debug: true }
  );
  check('no-apex fixture still detects core front geometry',
    detection && detection.bbox && detection.bandY > 0.55 && detection.axisX >= 0 && detection.axisX <= 1,
    `bandY=${detection && detection.bandY} axisX=${detection && detection.axisX}`);
  check('no-apex fixture has no left apex',
    detection && detection.apexLeft == null,
    `apexLeft=${JSON.stringify(detection && detection.apexLeft)}`);
  check('no-apex fixture has no right apex',
    detection && detection.apexRight == null,
    `apexRight=${JSON.stringify(detection && detection.apexRight)}`);
  check('no-apex debug explains missing apex',
    detection && detection.debug && detection.debug.apex
      && detection.debug.apex.accepted === false
      && typeof detection.debug.apex.missingReason === 'string',
    `apexDebug=${JSON.stringify(detection && detection.debug && detection.debug.apex)}`);
}

// ---- Test 5: Learned detection params propagate into the debug snapshot ----
// The bug we want to catch: someone tunes the detector and the debug
// snapshot stops reflecting the actual params used. Pass a non-default
// params object and confirm the same values show up under debug.detectionParams.
console.log('\nstage: detectSketchFromInkAnalysis honours custom detection params');
{
  const W = 256, H = 384;
  const customParams = {
    bandSearchStartRatio: 0.62,
    bandPreferredRatio: 0.85,
    rowNoiseMultiplier: 1.1,
    colNoiseMultiplier: 0.9,
  };
  const detection = pipeline.detectSketchFromInkAnalysis(
    buildSyntheticInkAnalysis(W, H),
    { cv: null, debug: true, params: customParams }
  );
  const dp = detection.debug && detection.debug.detectionParams;
  check('debug.detectionParams.bandPreferredRatio === 0.85',
    dp && Math.abs(dp.bandPreferredRatio - 0.85) < 1e-9,
    `got=${dp && dp.bandPreferredRatio}`);
  check('debug.detectionParams.bandSearchStartRatio === 0.62',
    dp && Math.abs(dp.bandSearchStartRatio - 0.62) < 1e-9,
    `got=${dp && dp.bandSearchStartRatio}`);
  check('debug.detectionParams.rowNoiseMultiplier === 1.1',
    dp && Math.abs(dp.rowNoiseMultiplier - 1.1) < 1e-9,
    `got=${dp && dp.rowNoiseMultiplier}`);
  check('debug.detectionParams.colNoiseMultiplier === 0.9',
    dp && Math.abs(dp.colNoiseMultiplier - 0.9) < 1e-9,
    `got=${dp && dp.colNoiseMultiplier}`);
}

// ---- Test 6: POM 6 PRESENT — cradle-cf-top detected, POM 6 DRAWABLE ----
// When the fixture has a real cradle / cup-bottom seam crossing the CF axis,
// the detector seeds cradle-cf-top and POM 6 produces a vertical line from
// the cradle seam down to cf-bottom, with x slightly offset from POM 5 so it
// reads as a distinct measurement.
console.log('\nstage: POM 6 present — cradle seam at CF, POM 6 DRAWABLE');
{
  const W = 256, H = 384;
  const analysis = buildSyntheticCradleInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });

  check('detection.cradleCfTop populated',
    detection.cradleCfTop && Number.isFinite(detection.cradleCfTop.x) && Number.isFinite(detection.cradleCfTop.y),
    `cradleCfTop=${JSON.stringify(detection.cradleCfTop)}`);
  check('cradle-cf-top sits between chest and band',
    detection.cradleCfTop
      && detection.chestY != null
      && detection.bandY != null
      && detection.cradleCfTop.y > detection.chestY
      && detection.cradleCfTop.y < detection.bandY,
    `cradleY=${detection.cradleCfTop && detection.cradleCfTop.y} chestY=${detection.chestY} bandY=${detection.bandY}`);
  check('cradle-cf-top x is close to detected axis',
    detection.cradleCfTop && Math.abs(detection.cradleCfTop.x - detection.axisX) < 0.02,
    `cradleX=${detection.cradleCfTop && detection.cradleCfTop.x} axisX=${detection.axisX}`);

  const sourceImage = { id: 'cradle-fixture', width: W, height: H };
  const anchors = pipeline.seedAnchorsFromDetection(detection, sourceImage, { skipLearning: true });
  const cradleAnchor = anchors.find(a => a.kind === 'cradle-cf-top');
  check('cradle-cf-top anchor seeded', !!cradleAnchor,
    `anchorKinds=${anchors.map(a => a.kind).join(',')}`);

  const fixture = pipeline.buildPOMFixtureFromAnchors(anchors, detection);
  const pom5 = fixture.annotations.find(r => r.pom === '5');
  const pom6 = fixture.annotations.find(r => r.pom === '6');
  const pom7 = fixture.annotations.find(r => r.pom === '7');
  const pom8 = fixture.annotations.find(r => r.pom === '8');

  check('POM 6 is DRAWABLE', pom6 && pom6.drawability === 'DRAWABLE',
    `drawability=${pom6 && pom6.drawability}`);
  check('POM 6 has valid start + end', pom6 && pom6.start && pom6.end,
    `start=${pom6 && JSON.stringify(pom6.start)} end=${pom6 && JSON.stringify(pom6.end)}`);
  check('POM 6 is vertical (start.x === end.x)',
    pom6 && pom6.start && pom6.end && Math.abs(pom6.start.x - pom6.end.x) < 1e-9,
    `start.x=${pom6 && pom6.start && pom6.start.x} end.x=${pom6 && pom6.end && pom6.end.x}`);
  check('POM 6 start is below POM 5 start (cradle below cf-top)',
    pom5 && pom6 && pom5.start && pom6.start && pom6.start.y > pom5.start.y,
    `pom5.start.y=${pom5 && pom5.start && pom5.start.y} pom6.start.y=${pom6 && pom6.start && pom6.start.y}`);
  check('POM 6 end aligns with cf-bottom row',
    pom5 && pom6 && pom5.end && pom6.end && Math.abs(pom6.end.y - pom5.end.y) < 1e-9,
    `pom5.end.y=${pom5 && pom5.end && pom5.end.y} pom6.end.y=${pom6 && pom6.end && pom6.end.y}`);
  check('POM 6 distinct from POM 5 (different x)',
    pom5 && pom6 && pom5.start && pom6.start && Math.abs(pom5.start.x - pom6.start.x) > 1e-6,
    `pom5.x=${pom5 && pom5.start && pom5.start.x} pom6.x=${pom6 && pom6.start && pom6.start.x}`);
  check('POM 5 remains vertical (regression)',
    pom5 && pom5.start && pom5.end && Math.abs(pom5.start.x - pom5.end.x) < 1e-9,
    `pom5.start.x=${pom5 && pom5.start && pom5.start.x} pom5.end.x=${pom5 && pom5.end && pom5.end.x}`);
  // POM 7 is anchor-driven (cradle-cup-top / -bottom). On this minimal
  // cradle-only fixture (no side-seam ink), the bottom-cup detector legitimately
  // declines to seed anchors and POM 7 demotes to REVIEW_ONLY. Accept either
  // outcome here; vertical-line geometry on the rich-fixture case is asserted
  // by the dedicated POM 7 tests below.
  check('POM 7 is vertical or REVIEW_ONLY (regression)',
    pom7 && (
      (pom7.start && pom7.end && Math.abs(pom7.start.x - pom7.end.x) < 1e-9)
      || (pom7.drawability === 'REVIEW_ONLY' && pom7.start == null && pom7.end == null)
    ),
    `drawability=${pom7 && pom7.drawability} start=${pom7 && JSON.stringify(pom7.start)} end=${pom7 && JSON.stringify(pom7.end)}`);
  check('POM 8 remains vertical (regression)',
    pom8 && pom8.start && pom8.end && Math.abs(pom8.start.x - pom8.end.x) < 1e-9,
    `pom8.start.x=${pom8 && pom8.start && pom8.start.x} pom8.end.x=${pom8 && pom8.end && pom8.end.x}`);
}

// ---- Test 7: POM 6 ABSENT — no cradle seam → REVIEW_ONLY ----
// When no cradle seam exists near CF (only chest + band + sides + axis), the
// detector must NOT fabricate cradle-cf-top, and POM 6 must demote to
// REVIEW_ONLY with null geometry. No approximate/ratio fallback is allowed.
console.log('\nstage: POM 6 absent — no cradle seam, POM 6 REVIEW_ONLY');
{
  const W = 256, H = 384;
  const analysis = buildSyntheticNoApexInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });

  check('detection.cradleCfTop is null (no cradle support)',
    detection.cradleCfTop == null,
    `cradleCfTop=${JSON.stringify(detection.cradleCfTop)}`);
  check('detection.cradleCfTopMissingReason populated',
    typeof detection.cradleCfTopMissingReason === 'string'
      && detection.cradleCfTopMissingReason.length > 0,
    `reason=${detection.cradleCfTopMissingReason}`);

  const sourceImage = { id: 'no-cradle-fixture', width: W, height: H };
  const anchors = pipeline.seedAnchorsFromDetection(detection, sourceImage, { skipLearning: true });
  const cradleAnchor = anchors.find(a => a.kind === 'cradle-cf-top');
  check('cradle-cf-top anchor NOT seeded when absent',
    cradleAnchor === undefined,
    `cradleAnchor=${JSON.stringify(cradleAnchor)}`);

  const fixture = pipeline.buildPOMFixtureFromAnchors(anchors, detection);
  const pom5 = fixture.annotations.find(r => r.pom === '5');
  const pom6 = fixture.annotations.find(r => r.pom === '6');

  check('POM 6 is REVIEW_ONLY', pom6 && pom6.drawability === 'REVIEW_ONLY',
    `drawability=${pom6 && pom6.drawability}`);
  check('POM 6 has null start', pom6 && pom6.start == null,
    `start=${pom6 && JSON.stringify(pom6.start)}`);
  check('POM 6 has null end', pom6 && pom6.end == null,
    `end=${pom6 && JSON.stringify(pom6.end)}`);
  check('POM 6 has an explicit missing-reason / uncertainty',
    pom6 && typeof pom6.uncertainty === 'string'
      && /cradle/i.test(pom6.uncertainty),
    `uncertainty=${pom6 && pom6.uncertainty}`);
  check('POM 5 unaffected — still has start + end (regression)',
    pom5 && pom5.start && pom5.end,
    `pom5=${JSON.stringify(pom5 && { start: pom5.start, end: pom5.end })}`);
}

// Synthetic torso with FULL features for POM 7. The silhouette occupies
// ~28% of the canvas width so the view-box splitter doesn't bisect it
// (it only attempts a vertical-valley split when the bbox covers ≥ 50%
// of the canvas — see splitMergedViewByVerticalValley). Includes: cup
// ellipses (cup-interior structure), chest / cradle / band rows, CF axis
// vertical, plus explicit thick side-seam columns at ±14% canvas width
// from CF so sideLeftCol / sideRightCol snap to the silhouette edge —
// giving the bottom-cup detector real estate between the cf-axis buffer
// and the side-seam buffer to find a candidate column.
function buildSyntheticBottomCupInkAnalysis(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: width, minY: height, maxX: -1, maxY: -1,
    colDark: new Uint32Array(width),
    rowDark: new Uint32Array(height),
  };

  const cx = width / 2;
  // Silhouette half-width (px) — sides at ±14% canvas width → bw ≈ 28%
  // canvas width, well under the 50% threshold for valley-split.
  const halfBox = Math.round(width * 0.14);
  const cupR = Math.min(halfBox, height * 0.16) * 0.85;
  const cupY = height * 0.40;
  const bandY = Math.round(height * 0.82);
  const bandThickness = Math.max(3, Math.round(height * 0.04));
  const chestY = Math.round(height * 0.30);
  const cradleY = Math.round(height * 0.66);
  const cradleThickness = Math.max(2, Math.round(height * 0.015));
  const sideLX = Math.round(cx - halfBox);
  const sideRX = Math.round(cx + halfBox);

  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (mask[p]) return;
    mask[p] = 1;
    stats.count += 1;
    if (x < stats.minX) stats.minX = x;
    if (y < stats.minY) stats.minY = y;
    if (x > stats.maxX) stats.maxX = x;
    if (y > stats.maxY) stats.maxY = y;
    stats.colDark[x] += 1;
    stats.rowDark[y] += 1;
  };

  // Cup ellipses — the lower curve of each ellipse acts as the cradle /
  // cup-bottom seam (this is what the detector finds as cradleRow). Drawn
  // with two theta passes (slight y offset) so the bottom is 2 px thick,
  // giving the detector a robust row peak.
  for (let theta = 0; theta < Math.PI * 2; theta += 0.005) {
    const xL = Math.round(cx - cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    const yL = Math.round(cupY + Math.sin(theta) * cupR);
    setDark(xL, yL);
    setDark(xL, yL + 1);
    const xR = Math.round(cx + cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    setDark(xR, yL);
    setDark(xR, yL + 1);
  }
  const chestSpanHalf = Math.round(halfBox * 0.92);
  for (let x = cx - chestSpanHalf; x <= cx + chestSpanHalf; x += 1) setDark(Math.round(x), chestY);
  // NO explicit horizontal cradle line — the cup-bottom curves are the
  // cradle seam. Adding a separate line confused band-row detection.
  for (let dy = 0; dy < bandThickness; dy += 1) {
    for (let x = sideLX; x <= sideRX; x += 1) setDark(x, bandY + dy);
  }
  for (let y = Math.round(height * 0.06); y <= bandY; y += 1) setDark(Math.round(cx), y);
  // Side-seam vertical lines, drawn with thickness 3 so colDark at the
  // side cols outscores any interior peak. Runs from chest down to band.
  for (let y = chestY; y <= bandY + bandThickness; y += 1) {
    for (let dx = 0; dx < 3; dx += 1) {
      setDark(sideLX - dx, y);
      setDark(sideRX + dx, y);
    }
  }
  // Explicit POM 7 vertical line on the cup side. Drawn from the cup-bottom
  // seam (which is what the detector identifies as the cradle row, ~ at the
  // bottom of the cup ellipses) down to the band baseline. The detector's
  // column-ink check requires continuous vertical evidence in this gap.
  const pom7X = Math.round(cx + halfBox * 0.55);
  const cupBottomY = Math.round(cupY + cupR);
  for (let y = cupBottomY - 2; y <= bandY + 1; y += 1) {
    for (let dx = -1; dx <= 1; dx += 1) setDark(pom7X + dx, y);
  }
  // Suppress unused-variable lint — cradleY/cradleThickness now describe
  // intent only; the curve itself supplies the row peak.
  void cradleY; void cradleThickness;

  return {
    engine: 'synthetic-bottom-cup-fixture',
    width, height, total,
    mask,
    stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

// Synthetic fixture for the POM 7 AMBIGUOUS case — chest + band + sides +
// CF axis ONLY. No cradle/cup-bottom seam, no cup ellipses (so there's no
// horizontal ink in the bottom-cup search region between cf-axis-buffer
// and side-buffer). The bottom-cup detector must refuse to seed cradle-
// cup-* anchors.
function buildSyntheticNoBottomCupInkAnalysis(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: width, minY: height, maxX: -1, maxY: -1,
    colDark: new Uint32Array(width),
    rowDark: new Uint32Array(height),
  };

  const cx = width / 2;
  const halfBox = Math.round(width * 0.14);
  const bandY = Math.round(height * 0.82);
  const bandThickness = Math.max(3, Math.round(height * 0.04));
  const chestY = Math.round(height * 0.30);
  const sideLX = Math.round(cx - halfBox);
  const sideRX = Math.round(cx + halfBox);

  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (mask[p]) return;
    mask[p] = 1;
    stats.count += 1;
    if (x < stats.minX) stats.minX = x;
    if (y < stats.minY) stats.minY = y;
    if (x > stats.maxX) stats.maxX = x;
    if (y > stats.maxY) stats.maxY = y;
    stats.colDark[x] += 1;
    stats.rowDark[y] += 1;
  };

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
  // NOTE: no cup ellipses, no cradle / cup-bottom horizontal seam — the
  // bottom-cup detector must NOT fabricate cradle-cup-* anchors from
  // chest/band/sides alone.

  return {
    engine: 'synthetic-no-bottom-cup-fixture',
    width, height, total,
    mask,
    stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

// Synthetic STRUCTURE-ONLY fixture: the sketch has cup outlines (so a
// cup-bottom arc is traceable and a cradle row is detected) AND a band line,
// but NO drawn POM 7 vertical line on the cup side. Since ADR 0022 this is
// the arc-tier case: the detector commits POM 7 on the traced cup-bottom arc
// at tier 'arc' (source seamArc, low confidence, reviewRequired) instead of
// demoting to REVIEW_ONLY. The anti-spoofing guard lives in the TIER: this
// structure ink must never be accepted at a trusted tier ('strong'/'seam').
function buildSyntheticCupNoPom7InkAnalysis(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: width, minY: height, maxX: -1, maxY: -1,
    colDark: new Uint32Array(width),
    rowDark: new Uint32Array(height),
  };

  const cx = width / 2;
  const halfBox = Math.round(width * 0.14);
  const cupR = Math.min(halfBox, height * 0.16) * 0.85;
  const cupY = height * 0.40;
  const bandY = Math.round(height * 0.82);
  const bandThickness = Math.max(3, Math.round(height * 0.04));
  const chestY = Math.round(height * 0.30);
  const cradleY = Math.round(height * 0.66);
  const cradleThickness = Math.max(2, Math.round(height * 0.015));
  const sideLX = Math.round(cx - halfBox);
  const sideRX = Math.round(cx + halfBox);

  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (mask[p]) return;
    mask[p] = 1;
    stats.count += 1;
    if (x < stats.minX) stats.minX = x;
    if (y < stats.minY) stats.minY = y;
    if (x > stats.maxX) stats.maxX = x;
    if (y > stats.maxY) stats.maxY = y;
    stats.colDark[x] += 1;
    stats.rowDark[y] += 1;
  };

  // Same cup ellipses + chest/band/sides/CF axis as the WITH-POM-7 fixture.
  // Cup-bottom curve acts as the cradle row; no explicit horizontal cradle
  // line. The ONLY difference vs the WITH-POM-7 fixture is the absence of
  // the explicit POM 7 vertical line.
  for (let theta = 0; theta < Math.PI * 2; theta += 0.005) {
    const xL = Math.round(cx - cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
    const yL = Math.round(cupY + Math.sin(theta) * cupR);
    setDark(xL, yL);
    setDark(xL, yL + 1);
    const xR = Math.round(cx + cupR * 0.8 + Math.cos(theta) * cupR * 0.55);
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
  // INTENTIONALLY OMITTED: the POM 7 vertical line between the cup-bottom
  // and the band baseline. The column between rows must be empty so the
  // detector's column-ink check rejects the trusted tiers — leaving only the
  // ADR 0022 arc tier to commit from the traced cup-bottom structure.
  void cradleY; void cradleThickness;

  return {
    engine: 'synthetic-cup-no-pom7-fixture',
    width, height, total,
    mask,
    stats,
    threshold: 80,
    luminanceThreshold: 160,
    backgroundLum: 255,
  };
}

// ---- Test 8: POM 7 PRESENT — cradle + side seams → DRAWABLE ----
// With a richer fixture (cradle row + visible side seams) the detector seeds
// cradle-cup-top/-bottom and POM 7 draws as a vertical line on the cup side,
// distinct from POM 6 (which lives at the CF axis).
console.log('\nstage: POM 7 present — bottom-cup cradle seam, POM 7 DRAWABLE');
{
  const W = 640, H = 480;
  const analysis = buildSyntheticBottomCupInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });

  check('detection.cradleCupTop populated',
    detection.cradleCupTop
      && Number.isFinite(detection.cradleCupTop.x)
      && Number.isFinite(detection.cradleCupTop.y),
    `cradleCupTop=${JSON.stringify(detection.cradleCupTop)}`);
  check('detection.cradleCupBottom populated',
    detection.cradleCupBottom
      && Number.isFinite(detection.cradleCupBottom.x)
      && Number.isFinite(detection.cradleCupBottom.y),
    `cradleCupBottom=${JSON.stringify(detection.cradleCupBottom)}`);
  check('cradle-cup-top sits on the detected cradle row',
    detection.cradleCupTop
      && detection.cradleY != null
      && detection.bandY != null
      && Math.abs(detection.cradleCupTop.y - detection.cradleY) < 1e-9
      && detection.cradleCupTop.y < detection.bandY,
    `cradleCupTop.y=${detection.cradleCupTop && detection.cradleCupTop.y} cradleY=${detection.cradleY} bandY=${detection.bandY}`);
  check('cradle-cup-bottom sits on the band row',
    detection.cradleCupBottom
      && detection.bandY != null
      && Math.abs(detection.cradleCupBottom.y - detection.bandY) < 0.04,
    `cradleCupBottom.y=${detection.cradleCupBottom && detection.cradleCupBottom.y} bandY=${detection.bandY}`);
  check('cradle-cup-top is OFF the CF axis (≥15% of bbox width away)',
    detection.cradleCupTop && detection.bbox
      && Math.abs(detection.cradleCupTop.x - detection.axisX) >= detection.bbox.width * 0.15,
    `dx=${detection.cradleCupTop && Math.abs(detection.cradleCupTop.x - detection.axisX)} bboxW=${detection.bbox && detection.bbox.width}`);
  check('cradle-cup-top and -bottom share the SAME x (vertical line)',
    detection.cradleCupTop && detection.cradleCupBottom
      && Math.abs(detection.cradleCupTop.x - detection.cradleCupBottom.x) < 1e-9,
    `top.x=${detection.cradleCupTop && detection.cradleCupTop.x} bot.x=${detection.cradleCupBottom && detection.cradleCupBottom.x}`);

  const sourceImage = { id: 'bottom-cup-fixture', width: W, height: H };
  const anchors = pipeline.seedAnchorsFromDetection(detection, sourceImage, { skipLearning: true });
  const cradleCupTopAnchor = anchors.find(a => a.kind === 'cradle-cup-top');
  const cradleCupBotAnchor = anchors.find(a => a.kind === 'cradle-cup-bottom');
  check('cradle-cup-top anchor seeded', !!cradleCupTopAnchor,
    `anchorKinds=${anchors.map(a => a.kind).join(',')}`);
  check('cradle-cup-bottom anchor seeded', !!cradleCupBotAnchor);

  const fixture = pipeline.buildPOMFixtureFromAnchors(anchors, detection);
  const pom5 = fixture.annotations.find(r => r.pom === '5');
  const pom6 = fixture.annotations.find(r => r.pom === '6');
  const pom7 = fixture.annotations.find(r => r.pom === '7');
  const pom8 = fixture.annotations.find(r => r.pom === '8');

  check('POM 7 is DRAWABLE', pom7 && pom7.drawability === 'DRAWABLE',
    `drawability=${pom7 && pom7.drawability}`);
  check('POM 7 has valid start + end', pom7 && pom7.start && pom7.end,
    `start=${pom7 && JSON.stringify(pom7.start)} end=${pom7 && JSON.stringify(pom7.end)}`);
  check('POM 7 is vertical (start.x === end.x)',
    pom7 && pom7.start && pom7.end && Math.abs(pom7.start.x - pom7.end.x) < 1e-9,
    `start.x=${pom7 && pom7.start && pom7.start.x} end.x=${pom7 && pom7.end && pom7.end.x}`);
  check('POM 7 start sits on the cradle row',
    pom7 && pom6 && pom7.start
      && detection.cradleY != null
      && Math.abs(pom7.start.y - detection.cradleY) < 0.02,
    `pom7.start.y=${pom7 && pom7.start && pom7.start.y} cradleY=${detection.cradleY}`);
  check('POM 7 end sits on the band baseline',
    pom7 && pom7.end
      && detection.bandY != null
      && Math.abs(pom7.end.y - detection.bandY) < 0.04,
    `pom7.end.y=${pom7 && pom7.end && pom7.end.y} bandY=${detection.bandY}`);
  if (pom6 && pom6.drawability === 'DRAWABLE' && pom6.start) {
    check('POM 7 is farther from CF than POM 6 (bottom-cup, not CF)',
      pom7 && pom7.start
        && Math.abs(pom7.start.x - detection.axisX) > Math.abs(pom6.start.x - detection.axisX),
      `pom7Δ=${Math.abs(pom7.start.x - detection.axisX)} pom6Δ=${Math.abs(pom6.start.x - detection.axisX)}`);
    check('POM 7 is NOT just POM 6 shifted (x differs by ≥10% width)',
      pom7 && pom7.start && Math.abs(pom7.start.x - pom6.start.x) > 0.05,
      `pom7.x=${pom7 && pom7.start && pom7.start.x} pom6.x=${pom6 && pom6.start && pom6.start.x}`);
  } else {
    // POM 6 wasn't drawable in this fixture (cradle row may not have ink at
    // axis after dx wins). Still assert POM 7 distance-from-axis directly.
    check('POM 7 is farther from CF than 15% bbox width (bottom-cup region)',
      pom7 && pom7.start && detection.bbox
        && Math.abs(pom7.start.x - detection.axisX) >= detection.bbox.width * 0.15,
      `pom7Δ=${pom7 && pom7.start && Math.abs(pom7.start.x - detection.axisX)} bboxW=${detection.bbox && detection.bbox.width}`);
  }
  check('POM 5 remains vertical (regression)',
    pom5 && pom5.start && pom5.end && Math.abs(pom5.start.x - pom5.end.x) < 1e-9,
    `pom5.start.x=${pom5 && pom5.start && pom5.start.x} pom5.end.x=${pom5 && pom5.end && pom5.end.x}`);
  // POM 8 = cf-top → cradle-cf-top. This fixture's "cradle" is the cup-ellipse
  // bottom curve; the curves don't cross the CF axis, so cradle-cf-top can't
  // be seeded and POM 8 legitimately demotes to REVIEW_ONLY. Accept either
  // outcome — POM 8 vertical geometry is asserted on Test 6's full-cradle
  // fixture where cradle-cf-top IS seeded.
  check('POM 8 is vertical or REVIEW_ONLY (anchor-driven)',
    pom8 && (
      (pom8.start && pom8.end && Math.abs(pom8.start.x - pom8.end.x) < 1e-9)
      || (pom8.drawability === 'REVIEW_ONLY' && pom8.start == null && pom8.end == null)
    ),
    `drawability=${pom8 && pom8.drawability} start=${pom8 && JSON.stringify(pom8.start)} end=${pom8 && JSON.stringify(pom8.end)}`);
}

// ---- Test 9: POM 7 ABSENT/AMBIGUOUS — no cradle row → REVIEW_ONLY ----
// Without a cradle row the bottom-cup detector cannot find ink support and
// must refuse to seed anchors. POM 7 demotes to REVIEW_ONLY with null
// geometry and an explicit reason — no horizontal-ratio fallback.
console.log('\nstage: POM 7 absent — no cradle seam at bottom cup, POM 7 REVIEW_ONLY');
{
  const W = 640, H = 480;
  const analysis = buildSyntheticNoBottomCupInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });

  check('detection.cradleCupTop is null (no cradle support)',
    detection.cradleCupTop == null,
    `cradleCupTop=${JSON.stringify(detection.cradleCupTop)}`);
  check('detection.cradleCupBottom is null',
    detection.cradleCupBottom == null,
    `cradleCupBottom=${JSON.stringify(detection.cradleCupBottom)}`);
  check('detection.cradleCupMissingReason populated',
    typeof detection.cradleCupMissingReason === 'string'
      && detection.cradleCupMissingReason.length > 0,
    `reason=${detection.cradleCupMissingReason}`);

  const sourceImage = { id: 'no-bottom-cup-fixture', width: W, height: H };
  const anchors = pipeline.seedAnchorsFromDetection(detection, sourceImage, { skipLearning: true });
  const cradleCupTopAnchor = anchors.find(a => a.kind === 'cradle-cup-top');
  const cradleCupBotAnchor = anchors.find(a => a.kind === 'cradle-cup-bottom');
  check('cradle-cup-top anchor NOT seeded when absent',
    cradleCupTopAnchor === undefined,
    `cradleCupTopAnchor=${JSON.stringify(cradleCupTopAnchor)}`);
  check('cradle-cup-bottom anchor NOT seeded when absent',
    cradleCupBotAnchor === undefined,
    `cradleCupBotAnchor=${JSON.stringify(cradleCupBotAnchor)}`);

  const fixture = pipeline.buildPOMFixtureFromAnchors(anchors, detection);
  const pom5 = fixture.annotations.find(r => r.pom === '5');
  const pom7 = fixture.annotations.find(r => r.pom === '7');
  const pom8 = fixture.annotations.find(r => r.pom === '8');

  check('POM 7 is REVIEW_ONLY', pom7 && pom7.drawability === 'REVIEW_ONLY',
    `drawability=${pom7 && pom7.drawability}`);
  check('POM 7 has null start', pom7 && pom7.start == null,
    `start=${pom7 && JSON.stringify(pom7.start)}`);
  check('POM 7 has null end', pom7 && pom7.end == null,
    `end=${pom7 && JSON.stringify(pom7.end)}`);
  check('POM 7 has an explicit cradle-related uncertainty',
    pom7 && typeof pom7.uncertainty === 'string'
      && /cradle/i.test(pom7.uncertainty),
    `uncertainty=${pom7 && pom7.uncertainty}`);
  check('POM 5 unaffected — still has start + end (regression)',
    pom5 && pom5.start && pom5.end,
    `pom5=${JSON.stringify(pom5 && { start: pom5.start, end: pom5.end })}`);
  // POM 8 now requires the cradle-cf-top anchor (rule.md: POM 8 end must be
  // cradle/cup-bottom seam near CF, NOT cf-bottom). This fixture has chest +
  // band + sides + CF axis only — no cradle row → cradle-cf-top is null →
  // POM 8 demotes to REVIEW_ONLY. Previously POM 8 used a chest/band ratio
  // fallback for its endpoints; rule.md forbids ratio-only anchors.
  check('POM 8 is REVIEW_ONLY when cradle-cf-top is missing',
    pom8 && pom8.drawability === 'REVIEW_ONLY',
    `drawability=${pom8 && pom8.drawability}`);
  check('POM 8 has null start (no cradle seam at CF)',
    pom8 && pom8.start == null,
    `start=${pom8 && JSON.stringify(pom8.start)}`);
  check('POM 8 has null end',
    pom8 && pom8.end == null,
    `end=${pom8 && JSON.stringify(pom8.end)}`);
}

// ---- Test 10: POM 7 STRUCTURE-ONLY — arc tier drafts for review ----
// The sketch has cup outlines (a traceable cup-bottom arc + detected cradle
// row) AND a band line, but no drawn POM 7 vertical line on the cup side.
// Since ADR 0022 the trusted tiers still reject (no vertical ink), and the
// arc tier commits instead: cradle-cup-* seed from the traced cup-bottom arc
// as source 'seamArc' / low confidence / reviewRequired, and POM 7 draws a
// vertical review line down to the band. The hard guards are the TIER and
// its isolation: arc evidence must never be promoted to 'strong'/'seam',
// never feed the cupModel, and never fire the POM 6 CF projection.
console.log('\nstage: POM 7 structure-only — cup outlines + band, no POM 7 line → arc tier');
{
  const W = 640, H = 480;
  const analysis = buildSyntheticCupNoPom7InkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });

  check('cradle row IS detected (cup ellipses + cradle row present)',
    detection.cradleY != null && detection.cradleY > 0,
    `cradleY=${detection.cradleY}`);
  check('band row IS detected',
    detection.bandY != null && detection.bandY > 0,
    `bandY=${detection.bandY}`);
  check('detection.cradleCupTop populated from the traced cup-bottom arc',
    detection.cradleCupTop
      && Number.isFinite(detection.cradleCupTop.x)
      && Number.isFinite(detection.cradleCupTop.y),
    `cradleCupTop=${JSON.stringify(detection.cradleCupTop)}`);
  check('detection.cradleCupBottom populated',
    detection.cradleCupBottom
      && Number.isFinite(detection.cradleCupBottom.x)
      && Number.isFinite(detection.cradleCupBottom.y),
    `cradleCupBottom=${JSON.stringify(detection.cradleCupBottom)}`);
  check('commit tier is "arc" — NOT a trusted tier (anti-spoofing guard)',
    detection.cradleCupTier === 'arc',
    `cradleCupTier=${detection.cradleCupTier}`);

  const sourceImage = { id: 'cup-no-pom7-fixture', width: W, height: H };
  const anchors = pipeline.seedAnchorsFromDetection(detection, sourceImage, { skipLearning: true });
  const cradleCupTopAnchor = anchors.find(a => a.kind === 'cradle-cup-top');
  const cradleCupBotAnchor = anchors.find(a => a.kind === 'cradle-cup-bottom');
  check('cradle-cup-top anchor seeded (arc tier)', !!cradleCupTopAnchor,
    `anchorKinds=${anchors.map(a => a.kind).join(',')}`);
  check('cradle-cup-bottom anchor seeded', !!cradleCupBotAnchor);
  check('cradle-cup-top source is seamArc',
    cradleCupTopAnchor && cradleCupTopAnchor.source === 'seamArc',
    `source=${cradleCupTopAnchor && cradleCupTopAnchor.source}`);
  check('cradle-cup-bottom source is seamArc',
    cradleCupBotAnchor && cradleCupBotAnchor.source === 'seamArc',
    `source=${cradleCupBotAnchor && cradleCupBotAnchor.source}`);
  check('cradle-cup-top confidence is low',
    cradleCupTopAnchor && cradleCupTopAnchor.confidence === 'low',
    `confidence=${cradleCupTopAnchor && cradleCupTopAnchor.confidence}`);
  check('cradle-cup-bottom confidence is low',
    cradleCupBotAnchor && cradleCupBotAnchor.confidence === 'low',
    `confidence=${cradleCupBotAnchor && cradleCupBotAnchor.confidence}`);
  check('cradle-cup-top is reviewRequired',
    cradleCupTopAnchor && cradleCupTopAnchor.reviewRequired === true,
    `reviewRequired=${cradleCupTopAnchor && cradleCupTopAnchor.reviewRequired}`);
  check('cradle-cup-bottom is reviewRequired',
    cradleCupBotAnchor && cradleCupBotAnchor.reviewRequired === true,
    `reviewRequired=${cradleCupBotAnchor && cradleCupBotAnchor.reviewRequired}`);
  check('cradle-cup-top carries an arc-tier QA note asking the TD to verify',
    cradleCupTopAnchor && Array.isArray(cradleCupTopAnchor.qaNotes)
      && cradleCupTopAnchor.qaNotes.some(n => /arc-tier/i.test(n) && /verify/i.test(n)),
    `qaNotes=${cradleCupTopAnchor && JSON.stringify(cradleCupTopAnchor.qaNotes)}`);

  // Isolation guards (ADR 0022 trust allowlist): the arc commit is
  // review-grade POM 7 evidence ONLY.
  check('cupModel does NOT take its bottom from the arc commit (bottomFromSeam stays false)',
    !detection.cupModel || detection.cupModel.bottomFromSeam !== true,
    `bottomFromSeam=${detection.cupModel && detection.cupModel.bottomFromSeam}`);
  // Cup-SIDE picker isolation (2026-08-19 follow-up G1). buildCupModel zeroes
  // seamSide unless the tier is trusted ('strong'/'seam'), so with an arc
  // commit the side may only come from apex evidence or the default-left
  // fallback. The seam-driven branches stamp a distinctive sideReason
  // ("cup-bottom seam confirms …" / "cup side taken from POM 7 cup-bottom
  // seam") — if a future change lets tier 'arc' steer the side picker, the
  // reason flips to seam phrasing and this guard goes red even while
  // bottomFromSeam stays false.
  check('cupModel present (side-picker isolation check is not vacuous)',
    !!detection.cupModel,
    `cupModel=${detection.cupModel == null ? 'null' : 'present'}`);
  check('cup-side picker ignores the arc commit (side from apex/default, never the arc seam side)',
    detection.cupModel
      && typeof detection.cupModel.sideReason === 'string'
      && /apex|default left cup/i.test(detection.cupModel.sideReason)
      && !/seam confirms|taken from POM 7/i.test(detection.cupModel.sideReason),
    `side=${detection.cupModel && detection.cupModel.side} sideReason=${detection.cupModel && detection.cupModel.sideReason}`);
  const cradleCfTopAnchor = anchors.find(a => a.kind === 'cradle-cf-top');
  check('POM 6 CF projection (seamProjected) does NOT fire from the arc tier',
    !cradleCfTopAnchor || cradleCfTopAnchor.source !== 'seamProjected',
    `cradle-cf-top source=${cradleCfTopAnchor && cradleCfTopAnchor.source}`);
  check('no anchor outside cradle-cup-* carries the seamArc source',
    anchors.every(a => a.source !== 'seamArc'
      || a.kind === 'cradle-cup-top' || a.kind === 'cradle-cup-bottom'),
    `seamArcKinds=${anchors.filter(a => a.source === 'seamArc').map(a => a.kind).join(',')}`);

  const fixture = pipeline.buildPOMFixtureFromAnchors(anchors, detection);
  const pom5 = fixture.annotations.find(r => r.pom === '5');
  const pom6 = fixture.annotations.find(r => r.pom === '6');
  const pom7 = fixture.annotations.find(r => r.pom === '7');
  const pom8 = fixture.annotations.find(r => r.pom === '8');

  check('POM 7 is DRAWABLE (arc tier draws a review line)',
    pom7 && pom7.drawability === 'DRAWABLE',
    `drawability=${pom7 && pom7.drawability}`);
  check('POM 7 has valid start + end', pom7 && pom7.start && pom7.end,
    `start=${pom7 && JSON.stringify(pom7.start)} end=${pom7 && JSON.stringify(pom7.end)}`);
  check('POM 7 is vertical (start.x === end.x)',
    pom7 && pom7.start && pom7.end && Math.abs(pom7.start.x - pom7.end.x) < 1e-9,
    `start.x=${pom7 && pom7.start && pom7.start.x} end.x=${pom7 && pom7.end && pom7.end.x}`);
  check('POM 7 start sits on the traced cup-bottom arc point',
    pom7 && pom7.start && detection.cradleCupTop
      && Math.abs(pom7.start.y - detection.cradleCupTop.y) < 0.02,
    `pom7.start.y=${pom7 && pom7.start && pom7.start.y} arcY=${detection.cradleCupTop && detection.cradleCupTop.y}`);
  check('POM 7 end sits on the band baseline',
    pom7 && pom7.end
      && detection.bandY != null
      && Math.abs(pom7.end.y - detection.bandY) < 0.04,
    `pom7.end.y=${pom7 && pom7.end && pom7.end.y} bandY=${detection.bandY}`);
  check('POM 5 unaffected', pom5 && pom5.start && pom5.end,
    `pom5=${JSON.stringify(pom5 && { start: pom5.start, end: pom5.end })}`);
  // POM 8 = cf-top → cradle-cf-top. Same situation as Test 8: cup-ellipse
  // bottom curves don't cross CF axis, so cradle-cf-top is null and POM 8
  // demotes to REVIEW_ONLY. Accept either outcome here.
  check('POM 8 is vertical or REVIEW_ONLY (anchor-driven)',
    pom8 && (
      (pom8.start && pom8.end && Math.abs(pom8.start.x - pom8.end.x) < 1e-9)
      || (pom8.drawability === 'REVIEW_ONLY' && pom8.start == null && pom8.end == null)
    ),
    `drawability=${pom8 && pom8.drawability} start=${pom8 && JSON.stringify(pom8.start)} end=${pom8 && JSON.stringify(pom8.end)}`);
  if (pom6 && pom6.drawability === 'DRAWABLE') {
    check('POM 6 still drawable when cradle row is present (regression)',
      pom6.start && pom6.end && Math.abs(pom6.start.x - pom6.end.x) < 1e-9,
      `pom6=${JSON.stringify({ start: pom6.start, end: pom6.end })}`);
  }
}

// ---- Test 11: derived-anchor cascade (Phase 3, plan 2) ----
// cf-bottom and cradle-cup-bottom carry `derivation` rules in the anchor
// schema: vertical drop from their primary onto the band-left → band-right
// line. Dragging a primary must re-derive the dependent; a pinned dependent
// must never move; a missing dependent must never be fabricated.
console.log('\nstage: deriveAnchors — drag cascade');
{
  const deriveAnchors = pipeline.deriveAnchors;
  check('deriveAnchors is exposed on the pipeline', typeof deriveAnchors === 'function');

  const mkAnchors = () => ([
    { kind: 'cf-top',            x: 0.50, y: 0.10 },
    { kind: 'cf-bottom',         x: 0.50, y: 0.80 },
    { kind: 'band-left',         x: 0.10, y: 0.80 },
    { kind: 'band-right',        x: 0.90, y: 0.80 },
    { kind: 'cradle-cup-top',    x: 0.30, y: 0.60 },
    { kind: 'cradle-cup-bottom', x: 0.30, y: 0.80 },
  ]);

  // Drag cf-top sideways → cf-bottom follows in x, stays on the band line.
  {
    const anchors = mkAnchors();
    anchors[0].x = 0.55;
    const updated = deriveAnchors(anchors, { changedKind: 'cf-top' });
    const cfBottom = anchors.find(a => a.kind === 'cf-bottom');
    check('cf-top drag re-derives cf-bottom', updated.includes('cf-bottom'),
      `updated=${JSON.stringify(updated)}`);
    check('cf-bottom follows cf-top x', Math.abs(cfBottom.x - 0.55) < 1e-9,
      `x=${cfBottom.x}`);
    check('cf-bottom stays on the band line', Math.abs(cfBottom.y - 0.80) < 1e-9,
      `y=${cfBottom.y}`);
    check('cf-top drag does not touch cradle-cup-bottom',
      !updated.includes('cradle-cup-bottom'), `updated=${JSON.stringify(updated)}`);
  }

  // Drag band-right down → both dependents re-project onto the slanted band.
  {
    const anchors = mkAnchors();
    anchors.find(a => a.kind === 'band-right').y = 0.88;
    const updated = deriveAnchors(anchors, { changedKind: 'band-right' });
    const cfBottom = anchors.find(a => a.kind === 'cf-bottom');
    const ccBottom = anchors.find(a => a.kind === 'cradle-cup-bottom');
    check('band drag re-derives both dependents',
      updated.includes('cf-bottom') && updated.includes('cradle-cup-bottom'),
      `updated=${JSON.stringify(updated)}`);
    // Band line: (0.10, 0.80) → (0.90, 0.88). At x=0.50: y = 0.84.
    check('cf-bottom lands on the slanted band at its x',
      Math.abs(cfBottom.y - 0.84) < 1e-6, `y=${cfBottom.y}`);
    // At x=0.30: y = 0.82.
    check('cradle-cup-bottom lands on the slanted band at its x',
      Math.abs(ccBottom.y - 0.82) < 1e-6, `y=${ccBottom.y}`);
  }

  // A pinned dependent never moves.
  {
    const anchors = mkAnchors();
    const cfBottom = anchors.find(a => a.kind === 'cf-bottom');
    cfBottom.derivedPinned = true;
    anchors[0].x = 0.60;
    const updated = deriveAnchors(anchors, { changedKind: 'cf-top' });
    check('pinned cf-bottom is skipped', !updated.includes('cf-bottom'),
      `updated=${JSON.stringify(updated)}`);
    check('pinned cf-bottom did not move', Math.abs(cfBottom.x - 0.50) < 1e-9,
      `x=${cfBottom.x}`);
  }

  // A gated-out dependent (POM 7 demoted → no cradle-cup-bottom anchor) is
  // never fabricated.
  {
    const anchors = mkAnchors().filter(a => a.kind !== 'cradle-cup-bottom');
    const before = anchors.length;
    anchors.find(a => a.kind === 'cradle-cup-top').x = 0.35;
    const updated = deriveAnchors(anchors, { changedKind: 'cradle-cup-top' });
    check('missing dependent is not fabricated',
      anchors.length === before && !updated.includes('cradle-cup-bottom'),
      `len=${anchors.length} updated=${JSON.stringify(updated)}`);
  }

  // Unrelated drags derive nothing.
  {
    const anchors = mkAnchors();
    const updated = deriveAnchors(anchors, { changedKind: 'apex-left' });
    check('unrelated drag derives nothing', updated.length === 0,
      `updated=${JSON.stringify(updated)}`);
  }
}

// ---- Test 12: detection carries the junction map (Phase 1, plan 2) ----
// Auxiliary data for the Phase 4 snap engine — must be present, normalized,
// and timed, without disturbing the rest of the pipeline.
console.log('\nstage: detection carries junction map');
{
  const W = 640, H = 480;
  const analysis = buildSyntheticInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });
  check('detection.junctions is an array', Array.isArray(detection.junctions),
    typeof detection.junctions);
  check('detection.junctionSummary present', !!detection.junctionSummary,
    JSON.stringify(detection.junctionSummary));
  check('junction stage was timed',
    detection.stageTimingsMs && detection.stageTimingsMs.junctions != null,
    JSON.stringify(detection.stageTimingsMs));
  const points = detection.junctions || [];
  check('synthetic torso yields skeleton features', points.length > 0,
    `points=${points.length}`);
  let badCoord = null;
  for (const p of points) {
    if (!(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) { badCoord = p; break; }
  }
  check('junction coords normalized to [0,1]', badCoord === null,
    badCoord ? JSON.stringify(badCoord) : '');
}

// ---- Test 12b: extractContours emits a clean evidence bundle (Phase 4) ----
// The contour stage now carries type-split feature points + stroke stats as
// SHAPE evidence, kept separate from geometry decisions, without disturbing
// the detection.junctions / junctionSummary contract asserted above.
console.log('\nstage: contour evidence bundle (Phase 4)');
{
  const W = 640, H = 480;
  const analysis = buildSyntheticInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });
  check('detection.endpoints is an array', Array.isArray(detection.endpoints),
    typeof detection.endpoints);
  check('detection.corners is an array', Array.isArray(detection.corners),
    typeof detection.corners);
  check('detection.strokeStats present', !!detection.strokeStats,
    JSON.stringify(detection.strokeStats));
  check('detection.contourEvidence summary present',
    !!detection.contourEvidence && typeof detection.contourEvidence === 'object',
    JSON.stringify(detection.contourEvidence));
  // The full junctions list is junctions + endpoints + corners; the split must
  // reconcile against the summary counts.
  const ce = detection.contourEvidence || {};
  const split = (ce.junctionCount || 0) + (ce.endpointCount || 0) + (ce.cornerCount || 0);
  check('evidence split reconciles with detection.junctions length',
    split === (detection.junctions || []).length,
    `split=${split} junctions=${(detection.junctions || []).length}`);
  check('endpoints carry only endpoint-type points',
    (detection.endpoints || []).every(p => p.type === 'endpoint'),
    JSON.stringify((detection.endpoints || []).map(p => p.type)));
  check('strokeStats.skeletonPx matches the junction summary',
    detection.strokeStats && detection.junctionSummary
      && detection.strokeStats.skeletonPx === detection.junctionSummary.skeletonPx,
    `stroke=${detection.strokeStats && detection.strokeStats.skeletonPx} summary=${detection.junctionSummary && detection.junctionSummary.skeletonPx}`);
  // Curve candidates are the deferred half of the bundle: without the Potrace
  // edge pass (pure Node pipeline) the summary reports none, cleanly.
  check('contourEvidence reports no traced curves in the pure pipeline',
    ce.traced === false && ce.curveCandidateCount === 0,
    JSON.stringify(ce));
}

// ---- Test 12c: explicit geometry facts (Phase 5) ----
// The geometry stage now emits a first-class, self-describing fact bundle:
// center axis, band line, cup/strap/seam candidate geometry, back-panel
// candidates, and the classified VIEW REGIONS (role + confidence) — produced
// BEFORE anchor placement so view-region detection is separated from anchoring.
// A deterministic geometry-quality verdict carries the review signal.
console.log('\nstage: explicit geometry facts (Phase 5)');
{
  const W = 640, H = 480;
  const analysis = buildSyntheticInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });
  const gf = detection.geometryFacts;
  check('detection.geometryFacts present', !!gf && typeof gf === 'object',
    JSON.stringify(gf ? Object.keys(gf) : gf));
  check('symmetryAxis carries pixel + normalized x',
    gf && gf.symmetryAxis && Number.isFinite(gf.symmetryAxis.xPx)
      && gf.symmetryAxis.xNorm >= 0 && gf.symmetryAxis.xNorm <= 1,
    JSON.stringify(gf && gf.symmetryAxis));
  check('bandLine carries normalized y in [0,1]',
    gf && gf.bandLine && gf.bandLine.yNorm >= 0 && gf.bandLine.yNorm <= 1,
    JSON.stringify(gf && gf.bandLine));
  check('viewRegions is a list with explicit roles',
    gf && Array.isArray(gf.viewRegions) && gf.viewRegions.length > 0
      && gf.viewRegions.every(r => typeof r.role === 'string' && 'roleConfidence' in r),
    JSON.stringify(gf && gf.viewRegions));
  check('exactly one view region is flagged primary',
    gf && gf.viewRegions.filter(r => r.isPrimary).length === 1,
    JSON.stringify(gf && gf.viewRegions.map(r => r.isPrimary)));
  check('view region bbox exposed in BOTH pixel and normalized space',
    gf && gf.viewRegions.every(r => r.bboxPx && r.bboxNorm
      && r.bboxNorm.x >= 0 && r.bboxNorm.x <= 1),
    JSON.stringify(gf && gf.viewRegions[0]));
  check('semantic-part candidate geometry present (cup/strap/seam/back)',
    gf && 'cupGeometry' in gf && 'strapGeometry' in gf
      && 'seamGeometry' in gf && 'backPanelGeometry' in gf,
    JSON.stringify(gf ? Object.keys(gf) : gf));
  check('geometry quality carries a review verdict + reasons',
    gf && gf.quality && typeof gf.quality.reviewRequired === 'boolean'
      && Array.isArray(gf.quality.reasons)
      && gf.quality.overall >= 0 && gf.quality.overall <= 1,
    JSON.stringify(gf && gf.quality));
  check('top-level geometryReviewRequired mirrors the quality verdict',
    detection.geometryReviewRequired === gf.quality.reviewRequired,
    `top=${detection.geometryReviewRequired} quality=${gf && gf.quality && gf.quality.reviewRequired}`);
  // The geometry facts are a surfacing of the frame the detector already found:
  // axis / band in the facts must equal the top-level detection coordinates.
  check('geometryFacts axis/band agree with top-level detection coords',
    gf && gf.symmetryAxis.xNorm === detection.axisX && gf.bandLine.yNorm === detection.bandY,
    `axis=${gf && gf.symmetryAxis.xNorm}/${detection.axisX} band=${gf && gf.bandLine.yNorm}/${detection.bandY}`);
  // Determinism: same ink analysis → identical geometry-quality verdict.
  const again = pipeline.detectSketchFromInkAnalysis(buildSyntheticInkAnalysis(W, H), { cv: null });
  check('geometry quality is deterministic (same in → same out)',
    again.geometryFacts && again.geometryFacts.quality.overall === gf.quality.overall
      && again.geometryReviewRequired === detection.geometryReviewRequired,
    `q1=${gf.quality.overall} q2=${again.geometryFacts && again.geometryFacts.quality.overall}`);
}

// ---- Test 13: normalized segmentation stage output (Phase 3) ----
// Segmentation is now a first-class stage: every backend produces one shape
// (backend id, bbox, deterministic quality, weak/review flags), surfaced on
// detection.segmentation plus top-level mirrors.
console.log('\nstage: segmentation normalized output + quality (Phase 3)');
{
  const W = 256, H = 384;
  const analysis = buildSyntheticInkAnalysis(W, H);
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });
  const seg = detection.segmentation;

  check('detection.segmentation block present', seg && typeof seg === 'object');
  check('segmentation.backend classified from engine', seg && seg.backend === 'synthetic',
    `backend=${seg && seg.backend}`);
  check('segmentation.componentsBackend is inhouse (cv=null)',
    seg && seg.componentsBackend === 'inhouse', `got=${seg && seg.componentsBackend}`);
  check('segmentation.quality is a number in [0,1]',
    seg && typeof seg.quality === 'number' && seg.quality >= 0 && seg.quality <= 1,
    `quality=${seg && seg.quality}`);
  check('segmentation.bbox normalized to [0,1]',
    seg && seg.bbox && seg.bbox.x >= 0 && seg.bbox.x <= 1
      && seg.bbox.width > 0 && seg.bbox.width <= 1,
    `bbox=${seg && JSON.stringify(seg.bbox)}`);
  check('segmentation carries deterministic sub-scores',
    seg && seg.subScores && typeof seg.subScores.coverage === 'number'
      && typeof seg.subScores.retention === 'number'
      && typeof seg.subScores.fragmentation === 'number',
    `subScores=${seg && JSON.stringify(seg.subScores)}`);
  check('segmentation block omits the raw mask (hasMask flag only)',
    seg && seg.mask === undefined && seg.hasMask === true,
    `mask=${seg && typeof seg.mask} hasMask=${seg && seg.hasMask}`);
  check('clean synthetic torso is NOT weak', seg && seg.weak === false,
    `weak=${seg && seg.weak} reasons=${seg && JSON.stringify(seg.reasons)}`);
  check('top-level segmentation mirrors present',
    detection.segmentationBackend === 'synthetic'
      && typeof detection.segmentationQuality === 'number'
      && detection.segmentationWeak === false
      && detection.segmentationReviewRequired === false,
    `mirrors=${JSON.stringify({ b: detection.segmentationBackend, q: detection.segmentationQuality, w: detection.segmentationWeak, r: detection.segmentationReviewRequired })}`);

  // Determinism: same ink analysis → identical quality + weak verdict.
  const again = pipeline.detectSketchFromInkAnalysis(buildSyntheticInkAnalysis(W, H), { cv: null });
  check('segmentation quality is deterministic (same in → same out)',
    again.segmentation && again.segmentation.quality === seg.quality
      && again.segmentation.weak === seg.weak,
    `q1=${seg.quality} q2=${again.segmentation && again.segmentation.quality}`);
}

// ---- Test 14: weak segmentation → review signal, not silence (Phase 3) ----
// A speckle-only mask survives the ink-count gate but the component cleanup
// discards everything, tripping the fail-open revert. That must surface as a
// weak, review-required segmentation with an explaining reason — never hidden.
function buildSyntheticSpeckleInkAnalysis(width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: width, minY: height, maxX: -1, maxY: -1,
    colDark: new Uint32Array(width),
    rowDark: new Uint32Array(height),
  };
  const setDark = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (mask[p]) return;
    mask[p] = 1;
    stats.count += 1;
    if (x < stats.minX) stats.minX = x;
    if (y < stats.minY) stats.minY = y;
    if (x > stats.maxX) stats.maxX = x;
    if (y > stats.maxY) stats.maxY = y;
    stats.colDark[x] += 1;
    stats.rowDark[y] += 1;
  };
  // Isolated single-pixel dots on a 5px grid: each its own tiny component,
  // all below the keep threshold → cleanup drops them → fail-open revert.
  for (let y = 20; y < 120; y += 5) {
    for (let x = 20; x < 120; x += 5) setDark(x, y);
  }
  return {
    engine: 'synthetic-speckle-fixture',
    width, height, total, mask, stats,
    threshold: 80, luminanceThreshold: 160, backgroundLum: 255,
  };
}
console.log('\nstage: weak segmentation surfaces as a review signal (Phase 3)');
{
  const W = 256, H = 384;
  const detection = pipeline.detectSketchFromInkAnalysis(
    buildSyntheticSpeckleInkAnalysis(W, H), { cv: null }
  );
  const seg = detection.segmentation;
  check('speckle mask still returns a detection with segmentation',
    seg && typeof seg === 'object', `segmentation=${JSON.stringify(seg)}`);
  check('speckle segmentation is weak', seg && seg.weak === true,
    `weak=${seg && seg.weak}`);
  check('speckle segmentation requires review', seg && seg.reviewRequired === true,
    `reviewRequired=${seg && seg.reviewRequired}`);
  check('speckle segmentation records the ink-cleanup revert',
    seg && seg.inkCleanupReverted === true, `reverted=${seg && seg.inkCleanupReverted}`);
  check('weak segmentation carries an explaining reason (not silent)',
    seg && Array.isArray(seg.reasons) && seg.reasons.length > 0
      && seg.reasons.some(r => /revert|speckle|noisy|component/i.test(r)),
    `reasons=${seg && JSON.stringify(seg.reasons)}`);
  check('top-level segmentationReviewRequired propagates',
    detection.segmentationReviewRequired === true,
    `flag=${detection.segmentationReviewRequired}`);
}

// ---- Test 15: too-little-ink early return still reports segmentation ----
// The "no detection" path (ink count below the floor) must not be opaque: it
// carries a normalized, weak segmentation block so review can act on it.
console.log('\nstage: empty-ink early return carries a weak segmentation block');
{
  const W = 128, H = 128;
  const total = W * H;
  const mask = new Uint8Array(total);
  const stats = {
    count: 0, minX: W, minY: H, maxX: -1, maxY: -1,
    colDark: new Uint32Array(W), rowDark: new Uint32Array(H),
  };
  // 50 ink pixels — below the 80-pixel segmentation floor → early return.
  for (let i = 0; i < 50; i += 1) {
    const x = 10 + i, y = 40;
    mask[y * W + x] = 1;
    stats.count += 1;
    stats.minX = Math.min(stats.minX, x); stats.maxX = Math.max(stats.maxX, x);
    stats.minY = Math.min(stats.minY, y); stats.maxY = Math.max(stats.maxY, y);
    stats.colDark[x] += 1; stats.rowDark[y] += 1;
  }
  const analysis = {
    engine: 'synthetic-empty-fixture', width: W, height: H, total, mask, stats,
    threshold: 80, luminanceThreshold: 160, backgroundLum: 255,
  };
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null });
  check('early-return detection has a segmentation block',
    detection.segmentation && typeof detection.segmentation === 'object',
    `segmentation=${JSON.stringify(detection.segmentation)}`);
  check('early-return segmentation flags emptyMask + weak',
    detection.segmentation && detection.segmentation.emptyMask === true
      && detection.segmentation.weak === true,
    `seg=${JSON.stringify(detection.segmentation)}`);
}

// ---- Summary ----
console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('pipeline-tests passed');
