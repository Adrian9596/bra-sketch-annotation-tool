// Shared machinery for the synthetic-diagnostic suites (POM 6/7/14, view roles).
//
// Each suite builds a synthetic ink mask, runs the REAL detection -> seed ->
// fixture pipeline headlessly in a Node VM (no browser), and asserts per-POM
// outcomes. This module owns the parts that are identical across suites:
//   - the headless DOM stub + VM sandbox that hosts app.js,
//   - readRuleFixture (loads the versioned rule JSON before app.js runs),
//   - loadPipeline (returns window.__braAutoModeDebug.pipeline),
//   - makeInkCanvas (Uint8Array mask + colDark/rowDark stats),
//   - runPipeline (detect -> seed -> buildFixture),
//   - pomRow (find a fixture annotation by POM id),
//   - runCases (shared PASS/FAIL/LIMITATION reporter + exit code).
//
// The rule JSON is loaded from `appDir` (project root). Suites live in
// scripts/, so each suite computes appDir as the parent of its own directory
// and passes it in; this file lives in scripts/lib/ so it never computes the
// project root itself.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Build a Proxy that answers any property access / call with another stub, so
// app.js can touch arbitrary DOM without throwing. Mirrors the browser-DOM
// shim the headless suites have always used.
export function makeStub() {
  const target = function () { return makeStub(); };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.asyncIterator || prop === 'then') return undefined;
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

// Load version.json + pom-template.json + anchor-schema.json from `appDir` and
// assemble the frozen BraMeasurementRules object app.js expects on window
// BEFORE it runs. Identical to the historical pom7-limitations logic.
export function readRuleFixture(appDir) {
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

// Build the VM sandbox, install the rule fixture, run app.js, and return the
// exposed pipeline object. Throws a clear error if the pipeline hook is
// missing (app.js failed to register window.__braAutoModeDebug.pipeline).
export function loadPipeline(appDir) {
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
    navigator: { userAgent: 'node-synthetic-detection' },
    Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float32Array, Float64Array,
    Map, Set, WeakMap, WeakSet, Promise,
    FreeOpenCVAPI: undefined,
    RealOpenCVAPI: undefined,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  windowStub.BraMeasurementRules = readRuleFixture(appDir);
  try {
    vm.runInContext(readFileSync(path.join(appDir, 'app.js'), 'utf8'), sandbox);
  } catch (_initError) {
    // Expected in this headless VM: init() touches browser DOM.
  }

  const pipeline = sandbox.window.__braAutoModeDebug && sandbox.window.__braAutoModeDebug.pipeline;
  if (!pipeline) {
    throw new Error('window.__braAutoModeDebug.pipeline was not registered — did app.js build cleanly? Run `npm run build`.');
  }
  return pipeline;
}

// A drawable ink canvas: a flat Uint8Array mask plus column/row dark counts
// and a bounding box, matching the shape detectSketchFromInkAnalysis expects.
export function makeInkCanvas(width, height) {
  const mask = new Uint8Array(width * height);
  const stats = {
    count: 0,
    minX: width,
    minY: height,
    maxX: -1,
    maxY: -1,
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
  return { mask, stats, setDark };
}

// Run the full pipeline on one synthetic analysis and return the three stage
// outputs so a suite can assert on any of them (detection signals, seeded
// anchors, or the drawn fixture).
export function runPipeline(pipeline, analysis, { id } = {}) {
  const detection = pipeline.detectSketchFromInkAnalysis(analysis, { cv: null, debug: true });
  const anchors = pipeline.seedAnchorsFromDetection(
    detection,
    { id: id || 'synthetic', width: analysis.width, height: analysis.height }
  );
  const fixture = pipeline.buildPOMFixtureFromAnchors(anchors, detection);
  return { detection, anchors, fixture };
}

// Find a fixture annotation row by POM id (accepts number or string).
export function pomRow(fixture, pomId) {
  if (!fixture || !Array.isArray(fixture.annotations)) return undefined;
  return fixture.annotations.find((row) => row.pom === String(pomId));
}

// Shared reporter. Prints the same PASS/FAIL/LIMITATION lines every suite uses
// and exits non-zero if any hard-expected case regressed. classifyFn receives
// the case object and returns a result object; the case declares either
// `hardExpected` (asserted PASS/FAIL) or `knownLimitation` (printed, never
// fatal). classifyFn results should expose:
//   - actual:     the value compared against hardExpected (required)
//   - detail:     optional one-line "geometry=..., ..." style summary
//   - reason:     optional detector reason string
//   - notes:      optional array of extra "  key: value" lines to print
//
// opts.guardLabel overrides the noun used in the pass/fail footer lines so a
// suite can keep a shorter phrase than its banner title (e.g. banner
// "POM 7 synthetic diagnostic matrix" but footer "Hard POM 7 diagnostic ...").
export function runCases(title, cases, classifyFn, opts = {}) {
  const guardLabel = opts.guardLabel || title;
  let hardFailures = 0;
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  for (const item of cases) {
    const result = classifyFn(item) || {};
    const status = item.hardExpected
      ? (result.actual === item.hardExpected ? 'PASS' : 'FAIL')
      : 'LIMITATION';
    if (status === 'FAIL') hardFailures += 1;
    console.log(`\n${status}: ${item.id}`);
    console.log(`  case: ${item.label}`);
    console.log(`  expected: ${item.hardExpected || 'observe and improve'}`);
    console.log(`  actual: ${result.actual}${result.detail ? ' ' + result.detail : ''}`);
    if (result.reason) console.log(`  reason: ${result.reason}`);
    if (Array.isArray(result.notes)) {
      for (const note of result.notes) console.log(`  ${note}`);
    }
    if (item.knownLimitation) console.log(`  limitation: ${item.knownLimitation}`);
  }
  if (hardFailures) {
    console.error(`\nFAILED: ${hardFailures} hard ${guardLabel} case(s) regressed.`);
    process.exit(1);
  }
  console.log(`\nHard ${guardLabel} guards passed.`);
}

// Shared view fixtures for the synthetic detection matrices (viewrole and
// POM 14 drew identical copies of these).
// A symmetric front bra blob: cups, chest line, band, CF axis, side seams,
// centered in its own box. High symmetry, moderate aspect — reads front_outer.
export function drawFront(setDark, bx, top, boxW, boxH) {
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
export function drawBack(setDark, bx, top, boxW, boxH) {
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
  // Single off-center back strap: breaks left/right symmetry, and is the
  // back-strap ink POM 14 measures.
  for (let y = top; y <= chestY; y += 1) setDark(Math.round(cx - halfBox * 0.5), y);
}

// The analysis object runPipeline() expects, built from a makeInkCanvas() canvas.
export function pack(canvas, engine) {
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
