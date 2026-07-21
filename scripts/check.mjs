#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_PARTS } from './source-parts.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

const jsFiles = [
  'vendor/opencv_free_api.js',
  'vendor/opencv_real_api.js',
  'vendor/potrace.js',
  'scripts/build-app.mjs',
  'scripts/auto-mode-smoke.mjs',
  'scripts/learning-tests.mjs',
  'scripts/accuracy-tests.mjs',
  'scripts/pipeline-tests.mjs',
  'scripts/serve.mjs',
  'scripts/static-server.mjs',
  'scripts/check.mjs',
];

const failures = [];

// Freshness gate (read-only): assert the committed app.js matches what src/*
// would build, and that the freshly-assembled bundle parses. `--verify` runs
// `new Function(bundle)` before a byte-for-byte compare, so it covers the parse
// validation the old rebuild step provided WITHOUT writing app.js.
//
// We deliberately do NOT rebuild-and-write here. Rebuilding would (a) mask a
// forgotten `npm run build` — the exact failure mode that shipped a stale
// bundle — and (b) be flaky on this Google Drive mount, where a write pollutes
// the next process's read cache. Build explicitly with `npm run build`; check
// only validates.
const freshness = spawnSync(process.execPath, ['scripts/build-app.mjs', '--verify'], {
  cwd: appDir,
  encoding: 'utf8',
});
if (freshness.status !== 0) {
  failures.push(`Stale build: ${(freshness.stderr || freshness.stdout).trim()}`);
}

for (const file of jsFiles) {
  const absolute = path.join(appDir, file);
  if (!existsSync(absolute)) {
    failures.push(`Missing JS file: ${file}`);
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', absolute], {
    cwd: appDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures.push(`Syntax failed: ${file}\n${result.stderr || result.stdout}`);
  }
}

// Membership gate: every src/**/*.js on disk must be registered in
// source-parts.mjs, or it silently never ships (an unregistered part has no
// compiler to complain — this is the only place that catches it).
const registered = new Set(SOURCE_PARTS);
for (const file of listJsFiles(path.join(appDir, 'src'))) {
  const relative = path.relative(appDir, file).split(path.sep).join('/');
  if (!registered.has(relative)) {
    failures.push(`Unregistered source part: ${relative} exists under src/ but is not listed in scripts/source-parts.mjs (it will never be bundled into app.js).`);
  }
}

for (const file of SOURCE_PARTS) {
  const absolute = path.join(appDir, file);
  if (!existsSync(absolute)) {
    failures.push(`Missing source part: ${file}`);
    continue;
  }
  try {
    // Parse the source part inside a function wrapper; source parts share
    // app-level scope after bundling, so they are not standalone modules.
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(absolute, 'utf8'));
  } catch (error) {
    failures.push(`Source part failed parse: ${file}\n${error && error.stack ? error.stack : error}`);
  }
}

const appCheck = spawnSync(process.execPath, ['--check', path.join(appDir, 'app.js')], {
  cwd: appDir,
  encoding: 'utf8',
});
if (appCheck.status !== 0) {
  failures.push(`Generated app.js syntax failed:\n${appCheck.stderr || appCheck.stdout}`);
}

const htmlPath = path.join(appDir, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const requiredScripts = [
  'vendor/opencv_free_api.js',
  'vendor/opencv_real_api.js',
  'vendor/potrace.js',
  'app.js',
];

for (const script of requiredScripts) {
  if (!html.includes(script)) failures.push(`index.html does not include ${script}`);
}

if (/<script>\s*\(\(\)\s*=>/.test(html)) {
  failures.push('index.html still contains the large inline app script.');
}

const parsedRules = new Map();
const ruleFiles = [
  'auto_mode_rules/version.json',
  'auto_mode_rules/pom-template.json',
  'auto_mode_rules/anchor-schema.json',
];
for (const file of ruleFiles) {
  const absolute = path.join(appDir, file);
  if (!existsSync(absolute)) {
    failures.push(`Missing rule JSON: ${file}`);
    continue;
  }
  try {
    parsedRules.set(file, JSON.parse(readFileSync(absolute, 'utf8')));
  } catch (error) {
    failures.push(`Rule JSON failed parse: ${file}\n${error && error.stack ? error.stack : error}`);
  }
}

if (parsedRules.size === ruleFiles.length) {
  failures.push(...validateRuleContract(
    parsedRules.get('auto_mode_rules/pom-template.json'),
    parsedRules.get('auto_mode_rules/anchor-schema.json')
  ));
}

const loaderSource = readFileSync(path.join(appDir, 'src/auto/rules/load-rules.js'), 'utf8');
if (!/window\.BraMeasurementRules/.test(loaderSource) || !/pom-template\.json/.test(loaderSource)) {
  failures.push('src/auto/rules/load-rules.js does not expose JSON-backed window.BraMeasurementRules.');
}

if (!/window\.__braAutoModeDebug/.test(readFileSync(path.join(appDir, 'app.js'), 'utf8'))) {
  failures.push('app.js does not expose window.__braAutoModeDebug for smoke tests.');
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log('check passed');

function validateRuleContract(pomTemplate, anchorSchema) {
  const out = [];
  const rows = Array.isArray(pomTemplate && pomTemplate.rows) ? pomTemplate.rows : [];
  const anchors = Array.isArray(anchorSchema && anchorSchema.anchors) ? anchorSchema.anchors : [];
  if (rows.length !== 18) out.push(`POM contract: expected exactly 18 rows, found ${rows.length}.`);
  if (!anchors.length) out.push('POM contract: anchor-schema.json has no anchors.');

  const validViews = new Set(['front_outer', 'front_inner', 'back', 'front_to_back']);
  const validPlacementRoles = new Set(['front_outer', 'front_inner', 'back']);
  const anchorKinds = new Set();
  for (const anchor of anchors) {
    if (!anchor || !anchor.kind) {
      out.push('POM contract: anchor schema row is missing kind.');
      continue;
    }
    const kind = String(anchor.kind);
    if (anchorKinds.has(kind)) out.push(`POM contract: duplicate anchor kind "${kind}".`);
    anchorKinds.add(kind);
  }

  const ids = new Set();
  for (const row of rows) {
    const id = String(row && row.id);
    if (!/^(?:[1-9]|1[0-8])$/.test(id)) {
      out.push(`POM contract: invalid POM id "${id}" (expected 1..18).`);
      continue;
    }
    if (ids.has(id)) out.push(`POM contract: duplicate POM id "${id}".`);
    ids.add(id);
    if (!validViews.has(row.view)) out.push(`POM contract: POM ${id} has invalid view "${row.view}".`);
    if (row.placementViewRole != null && !validPlacementRoles.has(row.placementViewRole)) {
      out.push(`POM contract: POM ${id} has invalid placementViewRole "${row.placementViewRole}".`);
    }
    if (row.view === 'front_to_back' && !row.placementViewRole) {
      out.push(`POM contract: POM ${id} front_to_back rows must declare placementViewRole.`);
    }
    if (!Array.isArray(row.requiredAnchors)) {
      out.push(`POM contract: POM ${id} is missing requiredAnchors.`);
    } else {
      out.push(...unknownAnchorMessages(id, 'requiredAnchors', row.requiredAnchors, anchorKinds));
    }
    if (row.optionalAnchors != null) {
      if (!Array.isArray(row.optionalAnchors)) {
        out.push(`POM contract: POM ${id} optionalAnchors must be an array.`);
      } else {
        out.push(...unknownAnchorMessages(id, 'optionalAnchors', row.optionalAnchors, anchorKinds));
      }
    }
  }
  for (let n = 1; n <= 16; n += 1) {
    if (!ids.has(String(n))) out.push(`POM contract: missing POM id "${n}".`);
  }
  return out;
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(absolute);
  }
  return out;
}

function unknownAnchorMessages(pomId, field, list, anchorKinds) {
  const out = [];
  for (const rawKind of list) {
    const kind = String(rawKind);
    if (!anchorKinds.has(kind)) out.push(`POM contract: POM ${pomId} ${field} references unknown anchor "${kind}".`);
  }
  return out;
}
