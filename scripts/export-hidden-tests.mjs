#!/usr/bin/env node
// Hidden-POM export tests: a POM line hidden via the review × toggle
// (state.hiddenAnnIds) must be omitted from the exported .xlsx spec — its
// whole row, not just its measurements — and the remaining rows must renumber
// contiguously. Paired POMs (1/2, 3/4) share one drawn line, so hiding it
// drops both halves. Boots the bundled app.js in a Node VM (same DOM-stub
// approach as scripts/junction-tests.mjs) and drives the canvas-free export
// hook, so no Chrome is needed.
//
// No Chrome, no deps: node scripts/export-hidden-tests.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

// ---- rule fixture (mirror load-rules normalizeAutoModeRules; keep pairing) ----
function readRuleFixture() {
  const version = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/version.json'), 'utf8'));
  const pomTemplate = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/pom-template.json'), 'utf8'));
  const anchorSchema = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules/anchor-schema.json'), 'utf8'));
  const POM_TEMPLATE = {};
  const POM_PAIR_PRIMARIES = {};
  for (const row of pomTemplate.rows) {
    const id = String(row.id);
    const entry = {
      desc: row.name,
      refL: row.refL == null ? null : row.refL,
      viewRole: row.placementViewRole || row.view,
      measurementView: row.view,
      requiredAnchors: row.requiredAnchors.slice(),
    };
    if (row.zh) entry.zh = String(row.zh);
    if (row.pairing != null) entry.pairing = row.pairing;
    POM_TEMPLATE[id] = entry;
    if (row.pairing && row.pairing.role === 'primary') {
      POM_PAIR_PRIMARIES[id] = { partner: String(row.pairing.partner) };
    }
  }
  return Object.freeze({
    POM_UNIT: version.pom_unit || 'in',
    POM_TEMPLATE,
    POM_PAIR_PRIMARIES,
    POM_SUGGESTIONS: {},
    ANCHOR_SCHEMA: anchorSchema.anchors.map((a) => Object.assign({}, a)),
    AUTO_TEMPLATE_VERSION: version.template_version,
    AUTO_RULE_VERSION: version.rule_version,
  });
}

// ---- Recursive DOM stub (same shape as junction-tests.mjs) ----
function makeStub() {
  const target = function () { return makeStub(); };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () { /* empty */ };
      if (prop === 'then') return undefined;
      if (prop === 'length') return 0;
      if (prop === 'value' || prop === 'textContent' || prop === 'innerHTML') return '';
      if (prop === 'getBoundingClientRect') return () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
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
  document: documentStub, addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }, location: { search: '', href: '', pathname: '' },
  prompt: () => null, confirm: () => true, alert() {},
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  BraMeasurementRules: readRuleFixture(), __braAutoModeDebug: null,
};
const sandbox = {
  window: windowStub, document: documentStub, console,
  setTimeout, clearTimeout, setInterval, clearInterval, performance: windowStub.performance,
  URL, URLSearchParams, navigator: { userAgent: 'node-test' },
  TextEncoder, TextDecoder, btoa, atob,
  Uint8Array, Uint8ClampedArray, Uint32Array, Int32Array, Float32Array, Float64Array,
  Map, Set, WeakMap, WeakSet, Promise, XMLHttpRequest: undefined,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(readFileSync(path.join(appDir, 'app.js'), 'utf8'), sandbox);
} catch (_initError) {
  // Expected: init() touches DOM the stub doesn't model fully.
}

const debug = sandbox.window.__braAutoModeDebug;
let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.error('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures += 1; }
}
const arrEq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

if (!debug || !debug.exportSpecXlsxBase64 || !debug.setHiddenAnnIds || !(debug.styleEvidence && debug.styleEvidence.pushAnnotation)) {
  console.error('FAIL: required debug hooks not registered (exportSpecXlsxBase64 / setHiddenAnnIds / styleEvidence.pushAnnotation)');
  process.exit(1);
}

// Seed two applied lines: POM 8 (unpaired) and POM 1 (primary of the 1/2 pair).
debug.styleEvidence.pushAnnotation({ id: 801, seq: 8, text: '8', start: { x: 0, y: 0 }, end: { x: 40, y: 0 } });
debug.styleEvidence.pushAnnotation({ id: 101, seq: 1, text: '1', start: { x: 0, y: 0 }, end: { x: 60, y: 0 } });

// ---- minimal STORE unzip (read side of zipStore) ----
function unzipStore(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no EOCD — not a ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n += 1) {
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + lName + lExtra;
    out[name] = buf.subarray(start, start + compSize);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function pomRows(hiddenIds) {
  debug.setHiddenAnnIds(hiddenIds);
  const b64 = await debug.exportSpecXlsxBase64('2026-07-08T10:00:00', { image: false });
  const sheet = unzipStore(Buffer.from(b64, 'base64'))['xl/worksheets/sheet1.xml'].toString('utf8');
  const rows = [];
  const re = /<c r="A(\d+)"[^>]*>\s*<v>(\d+)<\/v>/g;
  let m;
  while ((m = re.exec(sheet))) { const r = Number(m[1]); if (r >= 4) rows.push({ r, pom: Number(m[2]) }); }
  return rows;
}

async function main() {
  const base = await pomRows([]);
  arrEq('baseline: all 18 POM rows present', base.map((x) => x.pom), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  arrEq('baseline: rows contiguous 4..21', base.map((x) => x.r), Array.from({ length: 18 }, (_, i) => 4 + i));

  const hide8 = await pomRows([801]);
  arrEq('hide POM 8: its row is omitted', hide8.map((x) => x.pom), [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  arrEq('hide POM 8: remaining rows renumber contiguously 4..20', hide8.map((x) => x.r), Array.from({ length: 17 }, (_, i) => 4 + i));

  const hide1 = await pomRows([101]);
  arrEq('hide POM 1 (pair): both POM 1 and POM 2 omitted', hide1.map((x) => x.pom), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  arrEq('hide POM 1 (pair): 16 rows contiguous 4..19', hide1.map((x) => x.r), Array.from({ length: 16 }, (_, i) => 4 + i));

  // Image-render side: the exported SKETCH (PDF / Copy Image / Excel embedded
  // PNG) draws and crops from getExportAnnIds(), so a hidden POM's line must be
  // dropped from the drawing too — not just from the table above.
  check('image render: getExportAnnIds hook registered', typeof debug.getExportAnnIds === 'function');
  debug.setHiddenAnnIds([]);
  arrEq('image render: nothing hidden draws both lines', debug.getExportAnnIds().slice().sort((a, b) => a - b), [101, 801]);
  debug.setHiddenAnnIds([801]);
  arrEq('image render: hide POM 8 drops its line from the sketch', debug.getExportAnnIds(), [101]);
  debug.setHiddenAnnIds([101]);
  arrEq('image render: hide POM 1 drops its line from the sketch', debug.getExportAnnIds(), [801]);
  debug.setHiddenAnnIds([]);

  // Show-all restores every row (session toggle cleared).
  const restored = await pomRows([]);
  arrEq('show all: 18 rows restored', restored.map((x) => x.pom), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

  if (failures > 0) {
    console.error(`FAIL  export-hidden-tests: ${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('PASS  export-hidden-tests');
  }
}

await main();
