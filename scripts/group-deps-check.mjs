#!/usr/bin/env node
// Group-dependency ratchet (ADR 0103 Phase C, test written BEFORE the code).
//
// src/ is organized by feature group (the first directory under src/). All
// parts share one scope, so nothing stops a group from calling any other
// group's function — this suite is what does. It builds the bundle's
// group -> group reference graph (a part referencing a top-level name that
// another group's part declares) and compares it to a committed baseline:
//
//   default   FAIL if any group -> group reference exists that the baseline
//             does not list (a new coupling). References that disappeared are
//             reported as improvements; `--update` ratchets the baseline down.
//   --update  rewrite scripts/group-deps-baseline.json from the current tree.
//             Refuses to ADD references unless --allow-new is also given, so
//             the ratchet only ever tightens by accident-proof default.
//   --strict  additionally FAIL while any Phase C target reference remains
//             (see PHASE_C_TARGETS). Green --strict is the definition of
//             "Phase C done" for the dependency half of the phase.
//   --selftest  prove the detector can see: inject a synthetic cross-group
//             reference into an in-memory copy of one part and require the
//             comparison to flag exactly it.
//
// Scope rules: comments and string literals are ignored (a name inside a
// string is not a call); `app` (composition root) and `debug` (the test-hook
// contract) may reference anything and are not tracked as sources.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_PARTS } from './source-parts.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(appDir, 'scripts', 'group-deps-baseline.json');
const args = new Set(process.argv.slice(2));

const FREE_SOURCES = new Set(['app', 'debug']);
// Phase C targets. core must reference no feature group at all; the board
// must stop calling feature groups directly (they register with it instead).
// Services the board legitimately calls (project history, commands) are NOT
// targets.
const FEATURE_GROUPS = ['auto', 'dxf', 'graphics', 'library', 'measurements', 'mindmap', 'notes', 'techpack', 'treatments'];
const PHASE_C_TARGETS = [
  { from: 'core', to: '*', why: 'core has no feature knowledge (ADR 0103)' },
  ...FEATURE_GROUPS.map(to => ({ from: 'board', to, why: 'board calls features through registries, not by name' })),
];

const groupOf = file => file.split('/')[1];
const stripNonCode = text => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

export function buildGraph(sources) {
  // Top-level declarations: at each part's own base indent (most parts sit two
  // spaces into the IIFE, a few at column 0).
  const owner = new Map();
  for (const [file, text] of sources) {
    const indents = [...text.matchAll(/^( *)(?:async\s+)?function\s+[A-Za-z_$]/gm)].map(m => m[1].length);
    const base = indents.length ? Math.min(...indents) : 2;
    const re = new RegExp('^ {' + base + '}(?:(?:async\\s+)?function|const|let|var)\\s+([A-Za-z_$][\\w$]*)', 'gm');
    for (const m of text.matchAll(re)) if (!owner.has(m[1])) owner.set(m[1], file);
  }
  const edges = {}; // "from->to" -> sorted unique names
  for (const [file, text] of sources) {
    const from = groupOf(file);
    if (FREE_SOURCES.has(from)) continue;
    const ids = new Set(stripNonCode(text).match(/[A-Za-z_$][\w$]*/g) || []);
    for (const id of ids) {
      const decl = owner.get(id);
      if (!decl || decl === file) continue;
      const to = groupOf(decl);
      if (to === from) continue;
      (edges[from + '->' + to] ||= new Set()).add(id);
    }
  }
  return Object.fromEntries(Object.keys(edges).sort().map(k => [k, [...edges[k]].sort()]));
}

export function compare(baseline, current) {
  const added = [], removed = [];
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const was = new Set(baseline[key] || []), now = new Set(current[key] || []);
    for (const n of now) if (!was.has(n)) added.push(key + ' ' + n);
    for (const n of was) if (!now.has(n)) removed.push(key + ' ' + n);
  }
  return { added: added.sort(), removed: removed.sort() };
}

export function targetViolations(current) {
  const out = [];
  for (const [key, names] of Object.entries(current)) {
    const [from, to] = key.split('->');
    const t = PHASE_C_TARGETS.find(x => x.from === from && (x.to === '*' || x.to === to));
    if (t) out.push({ edge: key, count: names.length, names, why: t.why });
  }
  return out;
}

function readSources() {
  return SOURCE_PARTS.map(f => [f, readFileSync(path.join(appDir, f), 'utf8')]);
}

function countNames(graph) { return Object.values(graph).reduce((s, v) => s + v.length, 0); }

function main() {
  const sources = readSources();
  const current = buildGraph(sources);

  if (args.has('--selftest')) {
    // Inject one reference the tree does not have: core/math.js calling a
    // notes function. The comparison against the REAL current graph must
    // report exactly that one addition, and --strict must count it.
    const injected = sources.map(([f, t]) => [f, f === 'src/core/math.js' ? t + '\n  function __selftestProbe() { return drawNote; }\n' : t]);
    const probe = buildGraph(injected);
    const d = compare(current, probe);
    const ok = d.added.length === 1 && d.added[0] === 'core->notes drawNote' && d.removed.length === 0
      && targetViolations(probe).some(v => v.edge === 'core->notes');
    // A name inside a string or a comment must NOT count.
    const inert = sources.map(([f, t]) => [f, f === 'src/core/math.js' ? t + "\n  // drawNote()\n  const __s = 'drawNote';\n" : t]);
    const inertDiff = compare(current, buildGraph(inert));
    const ok2 = inertDiff.added.length === 0;
    console.log(`${ok && ok2 ? 'PASS' : 'FAIL'}  group-deps-check --selftest   injected reference detected: ${ok}; string/comment mention ignored: ${ok2}`);
    process.exit(ok && ok2 ? 0 : 1);
  }

  if (args.has('--update')) {
    const had = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).edges : {};
    const d = compare(had, current);
    if (existsSync(BASELINE) && d.added.length && !args.has('--allow-new')) {
      console.error(`REFUSED: --update would ADD ${d.added.length} reference(s); ratchets only tighten. Re-run with --allow-new if intended:`);
      for (const a of d.added.slice(0, 20)) console.error('  + ' + a);
      process.exit(1);
    }
    writeFileSync(BASELINE, JSON.stringify({
      note: 'Generated by scripts/group-deps-check.mjs --update. Group -> group references the bundle has today; a new one fails npm run group-deps-check. Shrink it, never grow it casually.',
      edges: current,
    }, null, 2) + '\n');
    console.log(`group-deps baseline written: ${Object.keys(current).length} group pairs, ${countNames(current)} names (removed ${d.removed.length}, added ${d.added.length})`);
    return;
  }

  if (!existsSync(BASELINE)) { console.error('No baseline: run node scripts/group-deps-check.mjs --update'); process.exit(1); }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).edges;
  const { added, removed } = compare(baseline, current);
  const targets = targetViolations(current);
  const targetNames = targets.reduce((s, t) => s + t.count, 0);
  let fail = false;
  if (added.length) {
    fail = true;
    console.log(`FAIL  group-deps-check   ${added.length} new cross-group reference(s) not in the baseline:`);
    for (const a of added.slice(0, 40)) console.log('  + ' + a);
    console.log('  Route the call through the owning group\'s interface, or (deliberately) node scripts/group-deps-check.mjs --update --allow-new');
  }
  if (removed.length) {
    console.log(`note  ${removed.length} baseline reference(s) are gone — ratchet down with: node scripts/group-deps-check.mjs --update`);
  }
  console.log(`info  Phase C targets remaining: ${targets.length} edges, ${targetNames} names`
    + (targets.length ? ' — ' + targets.map(t => `${t.edge}(${t.count})`).join(', ') : ''));
  if (args.has('--strict') && targets.length) {
    fail = true;
    console.log('FAIL  --strict: Phase C is done only when the list above is empty.');
  }
  if (!fail) console.log(`PASS  group-deps-check   ${Object.keys(current).length} group pairs, ${countNames(current)} names, no new cross-group reference`);
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
