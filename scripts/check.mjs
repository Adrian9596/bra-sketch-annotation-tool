#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_PARTS, AUTO_SEAM_WORKER_PARTS, DXF_WORKER_PARTS } from './source-parts.mjs';

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
// source-parts.mjs — in SOURCE_PARTS (app.js) or AUTO_SEAM_WORKER_PARTS
// (auto-seam-worker.js, US-120) — or it silently never ships (an unregistered
// part has no compiler to complain — this is the only place that catches it).
const allParts = [...new Set([...SOURCE_PARTS, ...AUTO_SEAM_WORKER_PARTS, ...DXF_WORKER_PARTS])];
const registered = new Set(allParts);
for (const file of listJsFiles(path.join(appDir, 'src'))) {
  const relative = path.relative(appDir, file).split(path.sep).join('/');
  if (!registered.has(relative)) {
    failures.push(`Unregistered source part: ${relative} exists under src/ but is not listed in scripts/source-parts.mjs (it will never be bundled into app.js, auto-seam-worker.js or dxf-worker.js).`);
  }
}

for (const file of allParts) {
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

// Shared-scope gates. Every source part is concatenated into ONE IIFE, so all
// top-level declarations land in a single shared scope with no module boundary
// to catch a collision or an ordering mistake. These two gates cover the only
// two ways that scope can bite silently — neither produces a syntax error, so
// nothing else in this file would notice.
// Each bundle is its own IIFE, so the gates run per bundle: a name may live in
// both bundles (the seam parts do, by design) but only once within each.
failures.push(...validateSharedScope(appDir, SOURCE_PARTS, 'app.js'));
failures.push(...validateSharedScope(appDir, AUTO_SEAM_WORKER_PARTS, 'auto-seam-worker.js'));
failures.push(...validateSharedScope(appDir, DXF_WORKER_PARTS, 'dxf-worker.js'));

// US-120 / US-124: a worker bundle must not carry Board code. The seam parts
// are pure by contract (ARCHITECTURE.md "Auto Seam" row) and the DXF parse
// layer was split out of dxf-import.js for exactly this reason (Phase 5);
// this gate keeps both worker-only entries honest too. `typeof document`
// feature checks are allowed (pixel-model.js uses one to pick DOM canvas vs
// OffscreenCanvas).
const WORKER_BUNDLES = [
  { name: 'auto-seam-worker.js', parts: AUTO_SEAM_WORKER_PARTS, hint: 'Keep src/auto/seam/* pure; Board code belongs in src/manual/auto-seam.js.' },
  { name: 'dxf-worker.js', parts: DXF_WORKER_PARTS, hint: 'Keep the DXF parse layer (src/geometry/dxf-parse.js, dxf-pattern-classify.js, dxf-native-parser.js) pure; Board code belongs in src/manual/dxf-import.js / dxf-worker-client.js.' },
];
for (const bundle of WORKER_BUNDLES) {
  for (const rel of bundle.parts) {
    const absolute = path.join(appDir, rel);
    if (!existsSync(absolute)) continue;
    const code = blankNonCode(readFileSync(absolute, 'utf8'));
    const lines = code.split('\n');
    for (let n = 0; n < lines.length; n += 1) {
      const line = lines[n];
      if (/\bstate\.[A-Za-z_$]/.test(line) || /\bshowToast\s*\(/.test(line) || /\bpushHistoryIfChanged\s*\(/.test(line)
        || /\bwindow\.(?!location\b)/.test(line)) {
        failures.push(`Worker bundle: ${rel}:${n + 1} touches Board/DOM state (\`${line.trim()}\`) but is part of ${bundle.name}, which has no Board, no DOM and no window. ${bundle.hint}`);
      }
    }
  }
}

for (const generated of ['app.js', 'auto-seam-worker.js', 'dxf-worker.js']) {
  const generatedCheck = spawnSync(process.execPath, ['--check', path.join(appDir, generated)], {
    cwd: appDir,
    encoding: 'utf8',
  });
  if (generatedCheck.status !== 0) {
    failures.push(`Generated ${generated} syntax failed:\n${generatedCheck.stderr || generatedCheck.stdout}`);
  }
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
  for (let n = 1; n <= 18; n += 1) {
    if (!ids.has(String(n))) out.push(`POM contract: missing POM id "${n}".`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared-scope validation
//
// The bundle is one IIFE, so `src/a.js` and `src/b.js` share a scope. Two
// hazards follow, and neither is a syntax error:
//
//   1. DUPLICATE top-level declarations. Two `function foo(){}` in different
//      parts is legal JS — the later one silently replaces the earlier for
//      EVERY caller, including callers that only ever meant the first. Editing
//      one copy then appears to do nothing.
//
//   2. LOAD-TIME use of a non-hoisted binding declared in a later part.
//      `function` and `var` hoist across the whole bundle, so a part may call
//      a function defined further down — that is normal here and heavily
//      relied upon. `const`/`let`/`class` do NOT hoist: reading one before its
//      own part has been evaluated throws a TDZ ReferenceError at load. This
//      only matters for references that execute AT LOAD TIME (brace depth 0);
//      a reference inside a function body runs long after every part has been
//      evaluated and is perfectly safe.
//
// Both gates work off a comment/string/regex-blanked copy of each part, so
// identifiers inside comments and string literals are never matched.
function validateSharedScope(dir, parts = SOURCE_PARTS, bundleName = 'app.js') {
  const out = [];
  const code = new Map();
  const decls = new Map();
  for (const rel of parts) {
    const absolute = path.join(dir, rel);
    if (!existsSync(absolute)) continue; // already reported by the membership gate
    const blanked = blankNonCode(readFileSync(absolute, 'utf8'));
    code.set(rel, blanked);
    decls.set(rel, topLevelDeclarations(blanked));
  }

  const sitesByName = new Map();
  for (const rel of parts) {
    for (const decl of decls.get(rel) || []) {
      if (!sitesByName.has(decl.name)) sitesByName.set(decl.name, []);
      sitesByName.get(decl.name).push({ ...decl, file: rel });
    }
  }

  // Gate 1 — duplicate top-level declarations.
  for (const [name, sites] of sitesByName) {
    if (sites.length < 2) continue;
    const where = sites.map(s => `${s.file}:${s.line} (${s.kind})`).join(', ');
    out.push(
      `Shared scope (${bundleName}): "${name}" is declared at top level in ${sites.length} parts — ${where}. `
      + 'All parts share one scope, so the last declaration silently wins for every caller. '
      + 'Keep exactly one and let the others call it.'
    );
  }

  // Gate 2 — load-time use of a later, non-hoisted binding.
  const order = new Map(parts.map((rel, i) => [rel, i]));
  for (const [name, sites] of sitesByName) {
    for (const site of sites) {
      if (site.kind === 'function' || site.kind === 'var') continue; // hoisted
      for (const rel of parts) {
        if ((order.get(rel) ?? 0) >= (order.get(site.file) ?? 0)) continue;
        const line = firstLoadTimeReference(code.get(rel) || '', name);
        if (line == null) continue;
        out.push(
          `Shared scope (${bundleName}): ${rel}:${line} reads "${name}" while the bundle is still loading, `
          + `but "${name}" is a ${site.kind} declared later in ${site.file}:${site.line}. `
          + 'const/let/class do not hoist, so this throws a TDZ ReferenceError at load. '
          + `Either move ${site.file} earlier in the parts list, or defer the read into a function body.`
        );
        break;
      }
    }
  }

  return out;
}

// Replace the CONTENT of comments, strings and regex literals with spaces,
// preserving length and newlines so reported line numbers stay accurate.
function blankNonCode(src) {
  const out = src.split('');
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === c) break;
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      i += 1;
      prev = c;
      continue;
    }
    // A `/` in prefix position starts a regex literal, not a division.
    if (c === '/' && /[(,=:[!&|?{};+\-*%^~<>]/.test(prev)) {
      i += 1;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        else if (src[i] === '\n') break;
        out[i] = ' ';
        i += 1;
      }
      i += 1;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}

// Declarations sitting at brace/paren depth 0 within a part are top level in
// the bundle's shared scope once concatenated.
function topLevelDeclarations(code) {
  // Built per call: a module-level `const` here would itself be in the TDZ
  // when validateSharedScope() runs from the top of this file — the exact
  // hazard gate 2 below exists to catch, which is how this line got written.
  const TOP_LEVEL_DECL = /\b(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  const found = [];
  let depth = 0;
  let paren = 0;
  const lines = code.split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    TOP_LEVEL_DECL.lastIndex = 0;
    let match;
    while ((match = TOP_LEVEL_DECL.exec(line)) !== null) {
      let d = depth;
      let p = paren;
      for (let k = 0; k < match.index; k += 1) {
        const ch = line[k];
        if (ch === '{') d += 1;
        else if (ch === '}') d -= 1;
        else if (ch === '(') p += 1;
        else if (ch === ')') p -= 1;
      }
      if (d === 0 && p === 0) found.push({ kind: match[1], name: match[2], line: n + 1 });
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '(') paren += 1;
      else if (ch === ')') paren -= 1;
    }
  }
  return found;
}

// First reference to `name` that executes at load time (brace depth 0),
// ignoring property access (obj.name) and object keys (name:). Returns the
// 1-based line number, or null when every reference is inside a function body.
function firstLoadTimeReference(code, name) {
  const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
  const lines = code.split('\n');
  let depth = 0;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const match = re.exec(line);
    if (match) {
      let d = depth;
      for (let k = 0; k < match.index; k += 1) {
        if (line[k] === '{') d += 1;
        else if (line[k] === '}') d -= 1;
      }
      const before = line.slice(0, match.index).trimEnd();
      const after = line.slice(match.index + name.length).trimStart();
      if (d === 0 && !before.endsWith('.') && !after.startsWith(':')) return n + 1;
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  return null;
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
