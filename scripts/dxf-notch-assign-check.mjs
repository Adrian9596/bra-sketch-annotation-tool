#!/usr/bin/env node
// US-134: the DXF notch search must answer exactly as the exhaustive search
// did, and stop measuring outlines that cannot win.
//
// dxfClassifyInstance (src/dxf/parse/dxf-pattern-classify.js) hands an unplaced
// short chain to its nearest outline when an endpoint lies within
// 0.5% of the instance diagonal of it. The exhaustive search measured every
// endpoint against every outline: on 2938常规L.dxf (620 outlines) that was
// 938,574 point-to-polygon calls = 15.1 s of a 15.5 s parse, in BOTH parsers.
// The fix skips an outline whose bounding rectangle is already too far away.
//
// Why this suite exists apart from the corpus proof: in the 45 real files only
// ONE (2938常规L) assigns any notch (7 chains), and a doubled tolerance leaves
// every corpus result unchanged. So the real files prove the "no notch" answers
// but barely touch the "notch" answers, the exact-tie rule, or the tolerance
// edge. This suite builds a 12 x 12 grid of outlines with notches placed to hit
// each of those, and checks three things:
//
//   1. Truth.        Every notch lands where an independent geometric oracle
//                    (point-to-rectangle distance, ties to the earlier outline)
//                    says, or stays an orphan when it is out of tolerance.
//   2. Equivalence.  The bundle's board AND native parses are identical to the
//                    same bundle with the skip removed, i.e. the exhaustive
//                    search.
//   3. Work.         The skip makes at most a tenth of the exhaustive search's
//                    distance calls.
//
// It also proves it can see: a deliberately over-eager skip must be caught by
// the oracle, and the exhaustive variant must fail the work bound.
//
// Pure node: loads the generated dxf-worker.js in a vm, no browser, no demo/.
// It therefore runs in the public mirror too.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleSource = readFileSync(path.join(appDir, 'dxf-worker.js'), 'utf8');

let passed = 0;
const failures = [];
const check = (ok, message) => { if (ok) passed += 1; else failures.push(message); };

// ---- The probe: the real bundle, optionally patched --------------------------

const BOUNDS_DECL = 'function dxfPatternDistanceToBounds(p, b) {';
const COUNT_DECL = 'function dxfPatternDistanceToPolygon(p, poly) {';
const REVERSE_FROM = 'for (let oi = 0; oi < outlines.length; oi += 1) {\n            const outline = outlines[oi];';
const REVERSE_TO = 'for (let oi = outlines.length - 1; oi >= 0; oi -= 1) {\n            const outline = outlines[oi];';

function patched(patches) {
  let code = bundleSource;
  for (const [from, to] of patches) {
    // A probe that no longer finds its target would silently test nothing.
    if (code.split(from).length - 1 !== 1) throw new Error(`probe target not found exactly once in dxf-worker.js: ${from}`);
    code = code.replace(from, () => to);
  }
  const tail = code.lastIndexOf('})();');
  if (tail < 0) throw new Error('dxf-worker.js footer not found');
  code = code.slice(0, tail) + 'globalThis.__p = { parseDxfDocument, parseDxfNativeModel };\n' + code.slice(tail);
  const sandbox = { console, TextDecoder, performance };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.__calls = 0;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return {
    parseBoard: text => { sandbox.__calls = 0; const r = sandbox.__p.parseDxfDocument(text, {}); return { r, calls: sandbox.__calls }; },
    parseNative: text => { sandbox.__calls = 0; const r = sandbox.__p.parseDxfNativeModel(text, {}); return { r, calls: sandbox.__calls }; },
  };
}

// The probes hook the helpers by NAME (the declaration line), not by the
// search loop's wording, so a regression inside that loop is still measured by
// the real assertions below instead of crashing the probe. A probe whose target
// has gone is reported as blind and its checks are skipped; the rest still run.
const COUNT = [COUNT_DECL, `${COUNT_DECL} globalThis.__calls += 1;`];
const wrapBounds = body => [BOUNDS_DECL, `${BOUNDS_DECL} ${body} }\n  function dxfPatternDistanceToBoundsOriginal(p, b) {`];
const variants = {};
const defineVariant = (name, patches) => {
  try { variants[name] = patched(patches); } catch (error) { variants[name] = null; failures.push(`probe blind (${name}): ${error.message.split('\n')[0]}`); }
};
defineVariant('real', [COUNT]);
// Never skips: the exhaustive search the skip replaced.
defineVariant('exhaustive', [COUNT, wrapBounds('return 0;')]);
// Control: a lower bound four times too large skips outlines it must not.
defineVariant('overEager', [COUNT, wrapBounds('return dxfPatternDistanceToBoundsOriginal(p, b) * 4;')]);
// Control: an outline loop that runs backwards breaks the tie rule.
defineVariant('reversedOutlines', [COUNT, [REVERSE_FROM, REVERSE_TO]]);
if (!variants.real) { for (const message of failures) console.log(`FAIL  ${message}`); process.exit(1); }

// ---- The fixture --------------------------------------------------------------

const P = (code, value) => [String(code), String(value)];
const dxfText = pairs => pairs.map(p => p[0] + '\n' + p[1]).join('\n') + '\n';
const lineEntity = (x1, y1, x2, y2, layer) => [P(0, 'LINE'), ...(layer ? [P(8, layer)] : []), P(10, x1), P(20, y1), P(11, x2), P(21, y2)];

// Every coordinate is a multiple of 1/8, so distances and ties are exact in binary.
// Outlines 8 wide x 6 tall with a 0.5 gap. Deliberately NOT square: with a square
// a swapped width/height in the distance-to-rectangle helper would go unseen.
const N = 12, W = 8, H = 6, PX = 8.5, PY = 6.5;
const rects = [];
const entities = [P(0, 'SECTION'), P(2, 'ENTITIES')]; // flat list of [group code, value] pairs
for (let j = 0; j < N; j += 1) {
  for (let i = 0; i < N; i += 1) {
    const x0 = i * PX, y0 = j * PY;
    rects.push({ i, j, x0, y0, key: `${x0},${y0}` });
    entities.push(
      ...lineEntity(x0, y0, x0 + W, y0, '1'), ...lineEntity(x0 + W, y0, x0 + W, y0 + H, '1'),
      ...lineEntity(x0 + W, y0 + H, x0, y0 + H, '1'), ...lineEntity(x0, y0 + H, x0, y0, '1'),
    );
  }
}
const rectAt = (i, j) => rects[j * N + i];

// Notches carry no layer, so the classifier cannot name them: they reach the
// notch rule only because they sit outside every outline. 62 of them: one per
// perimeter outline (44), 3 out of tolerance, 2 corners, 10 exact ties, and 3
// that decide by distance or by endpoint.
const notches = [];
const addNotch = (name, a, b) => notches.push({ name, a, b });
const D = [0.125, 0.25, 0.5, 0.5625];
let dIndex = 0;
for (const r of rects) {
  const edge = r.j === 0 ? 'below' : r.j === N - 1 ? 'above' : r.i === 0 ? 'left' : r.i === N - 1 ? 'right' : null;
  if (!edge) continue;
  const d = D[dIndex % D.length]; dIndex += 1;
  if (edge === 'below') addNotch(`edge ${r.i},${r.j} below ${d}`, { x: r.x0 + 3.5, y: r.y0 - d }, { x: r.x0 + 3.5, y: r.y0 - d - 0.25 });
  if (edge === 'above') addNotch(`edge ${r.i},${r.j} above ${d}`, { x: r.x0 + 3.5, y: r.y0 + H + d }, { x: r.x0 + 3.5, y: r.y0 + H + d + 0.25 });
  if (edge === 'left') addNotch(`edge ${r.i},${r.j} left ${d}`, { x: r.x0 - d, y: r.y0 + 3.5 }, { x: r.x0 - d - 0.25, y: r.y0 + 3.5 });
  if (edge === 'right') addNotch(`edge ${r.i},${r.j} right ${d}`, { x: r.x0 + W + d, y: r.y0 + 3.5 }, { x: r.x0 + W + d + 0.25, y: r.y0 + 3.5 });
}
// Outside the tolerance (about 1.25x and 4x of it): orphans.
for (const i of [2, 9]) addNotch(`out of tolerance ${i} 0.9`, { x: i * PX + 6.5, y: -0.9 }, { x: i * PX + 6.5, y: -1.15 });
addNotch('far 3.0', { x: 4 * PX + 6.5, y: -3 }, { x: 4 * PX + 6.5, y: -3.25 });
// An outside corner: nearest by a diagonal.
// Euclidean 0.530 but Manhattan 0.75 (> the tolerance): a distance-to-bounds that
// added the two axes instead of combining them would skip this outline.
addNotch('corner 0,0', { x: -0.375, y: -0.375 }, { x: -0.5, y: -0.375 });
{
  const right = (N - 1) * PX + W, top = (N - 1) * PY + H;
  addNotch(`corner ${N - 1},${N - 1}`, { x: right + 0.375, y: top + 0.375 }, { x: right + 0.5, y: top + 0.375 });
}
// Inside the 0.5 gaps. Exact ties go to the earlier outline; otherwise the
// nearer outline wins even when it is the LATER one.
for (const [i, j] of [[1, 1], [5, 3], [8, 6], [10, 9], [3, 10]]) {
  const r = rectAt(i, j);
  addNotch(`tie vertical gap ${i},${j}`, { x: r.x0 + W + 0.25, y: r.y0 + 3 }, { x: r.x0 + W + 0.25, y: r.y0 + 3.25 });
  addNotch(`tie horizontal gap ${i},${j}`, { x: r.x0 + 2, y: r.y0 + H + 0.25 }, { x: r.x0 + 2.25, y: r.y0 + H + 0.25 });
}
{
  const a = rectAt(2, 2), b = rectAt(6, 4), c = rectAt(4, 7);
  addNotch('nearer is the earlier outline', { x: a.x0 + W + 0.125, y: a.y0 + 5 }, { x: a.x0 + W + 0.125, y: a.y0 + 5.25 });
  addNotch('nearer is the LATER outline', { x: b.x0 + W + 0.375, y: b.y0 + 5 }, { x: b.x0 + W + 0.375, y: b.y0 + 5.25 });
  addNotch('endpoints tie across the gap', { x: c.x0 + W + 0.125, y: c.y0 + 1 }, { x: c.x0 + W + 0.375, y: c.y0 + 1 });
}
for (const n of notches) entities.push(...lineEntity(n.a.x, n.a.y, n.b.x, n.b.y, null));
entities.push(P(0, 'ENDSEC'), P(0, 'EOF'));
const text = dxfText(entities);

// ---- The oracle: geometry only, no code from the bundle ------------------------

const allPoints = [...rects.flatMap(r => [{ x: r.x0, y: r.y0 }, { x: r.x0 + W, y: r.y0 + H }]), ...notches.flatMap(n => [n.a, n.b])];
const xs = allPoints.map(p => p.x), ys = allPoints.map(p => p.y);
const instanceDiag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
const notchTol = 0.005 * instanceDiag;
const notchMaxLen = 0.02 * instanceDiag;
const distanceToRect = (p, r) => Math.hypot(Math.max(r.x0 - p.x, 0, p.x - (r.x0 + W)), Math.max(r.y0 - p.y, 0, p.y - (r.y0 + H)));

const expected = new Map();
let fixtureIssues = 0;
for (const n of notches) {
  let best = null, bestD = Infinity;
  for (const r of rects) { // file order, strict `<`: ties to the earlier outline
    const d = Math.min(distanceToRect(n.a, r), distanceToRect(n.b, r));
    if (d < bestD) { bestD = d; best = r; }
  }
  n.dist = bestD;
  n.len = Math.hypot(n.a.x - n.b.x, n.a.y - n.b.y);
  expected.set(n.name, bestD <= notchTol ? best.key : 'orphan');
  // A notch sitting on the tolerance would make the oracle and the bundle
  // disagree over rounding rather than over logic.
  if (Math.abs(bestD - notchTol) < 0.02 || n.len > notchMaxLen) fixtureIssues += 1;
}
check(fixtureIssues === 0, `fixture drifted: ${fixtureIssues} notch(es) sit within 0.02 of the tolerance (${notchTol.toFixed(4)}) or exceed the max length`);
const tieNames = notches.filter(n => /^tie|endpoints tie/.test(n.name)).map(n => n.name);
check(tieNames.length >= 11, 'fixture must carry the exact-tie notches');
check(expected.size === 62 && [...expected.values()].filter(v => v === 'orphan').length === 3, `fixture must carry 62 notches, three of them out of tolerance (got ${expected.size})`);

// ---- Reading a parse ----------------------------------------------------------

function assignments(board) {
  const got = new Map();
  if (!board.r.ok) return got;
  // The board parser returns screen coordinates: Y is the DXF's Y negated.
  const byCoords = new Map(notches.map(n => [`${n.a.x},${n.a.y}|${n.b.x},${n.b.y}`, n.name]));
  const nameOf = seg => byCoords.get(`${seg.a.x},${-seg.a.y}|${seg.b.x},${-seg.b.y}`) || byCoords.get(`${seg.b.x},${-seg.b.y}|${seg.a.x},${-seg.a.y}`);
  board.r.pieces.forEach((piece, k) => {
    const isOrphan = board.r.patterns[k].orphan;
    const outline = piece.filter(s => s.layer === '1');
    const key = isOrphan || !outline.length ? 'orphan' : `${Math.min(...outline.flatMap(s => [s.a.x, s.b.x]))},${-Math.max(...outline.flatMap(s => [s.a.y, s.b.y]))}`;
    for (const seg of piece) if (seg.layer !== '1') { const name = nameOf(seg); if (name) got.set(name, key); }
  });
  return got;
}

function mismatches(board) {
  const got = assignments(board);
  return notches.filter(n => got.get(n.name) !== expected.get(n.name)).map(n => `${n.name}: got ${got.get(n.name)}, expected ${expected.get(n.name)}`);
}

const run = {};
for (const [name, probe] of Object.entries(variants)) if (probe) run[name] = { board: probe.parseBoard(text), native: probe.parseNative(text) };

// 1. Truth.
if (run.real.board.r.ok !== true) {
  console.log(`FAIL  the fixture did not parse: ${run.real.board.r.reason} ${run.real.board.r.message || ''}`);
  process.exit(1);
}
const realMismatch = mismatches(run.real.board);
check(run.real.board.r.ok === true, `board parse of the fixture failed: ${run.real.board.r.reason || ''}`);
check(realMismatch.length === 0, `notches disagree with the oracle (${realMismatch.length}): ${realMismatch.slice(0, 4).join(' | ')}`);
const orphanCount = run.real.board.r.patterns.filter(p => p.orphan).length;
check(orphanCount === 3, `exactly the 3 out-of-tolerance notches must stay orphans, got ${orphanCount}`);
check(run.real.board.r.patterns.filter(p => p.kind === 'classified').length === N * N, `the grid must stay ${N * N} patterns`);
const laterWins = notches.filter(n => /LATER/.test(n.name) && expected.get(n.name) === rectAt(7, 4).key).length;
check(laterWins === 1, 'fixture must contain a notch whose nearest outline is the later one');
check(run.real.native.r.ok !== false && run.real.native.r.pieces.length === run.real.board.r.pieces.length,
  `board and native parses must agree on the piece count (${run.real.board.r.pieces.length} vs ${run.real.native.r.pieces && run.real.native.r.pieces.length})`);

// 2. Equivalence with the exhaustive search, in both parsers.
const same = (a, b) => JSON.stringify(a.r) === JSON.stringify(b.r);
if (run.exhaustive) {
  check(same(run.real.board, run.exhaustive.board), 'board parse differs from the exhaustive search');
  check(same(run.real.native, run.exhaustive.native), 'native parse differs from the exhaustive search');
  check(mismatches(run.exhaustive.board).length === 0, 'the exhaustive variant must itself agree with the oracle (else the oracle is wrong)');
}

// 3. Work. The exhaustive search must have measured every endpoint against
// every outline; the skip must make at most a tenth of those calls.
const candidates = notches.length;
const exhaustiveFloor = candidates * 2 * N * N;
const workBoundHolds = r => r.board.calls * 10 <= run.exhaustive.board.calls && r.native.calls * 10 <= run.exhaustive.native.calls;
if (run.exhaustive) {
  check(run.exhaustive.board.calls >= exhaustiveFloor, `probe blind: the exhaustive variant made ${run.exhaustive.board.calls} distance calls, expected at least ${exhaustiveFloor}`);
  check(run.real.board.calls > 0, 'probe blind: the real bundle made no distance calls');
  check(workBoundHolds(run.real), `the skip must cut distance calls at least 10x: ${run.real.board.calls} vs ${run.exhaustive.board.calls} (board), ${run.real.native.calls} vs ${run.exhaustive.native.calls} (native)`);
}

// 4. The suite can see.
if (run.overEager) {
  check(mismatches(run.overEager.board).length > 0, 'control failed: an over-eager skip went unnoticed by the oracle');
  if (run.exhaustive) check(!same(run.overEager.board, run.exhaustive.board), 'control failed: an over-eager skip went unnoticed by the equivalence check');
}
if (run.reversedOutlines) check(mismatches(run.reversedOutlines.board).length > 0, 'control failed: a reversed outline loop (wrong tie rule) went unnoticed by the oracle');
if (run.exhaustive) check(!workBoundHolds(run.exhaustive), 'control failed: the exhaustive search passed the work bound');

if (failures.length) {
  for (const message of failures) console.log(`FAIL  ${message}`);
  console.log(`FAIL  dxf-notch-assign-check   ${passed}/${passed + failures.length} assertions ok`);
  process.exit(1);
}
console.log(`INFO  dxf-notch-assign-check   ${notches.length} notches over ${N * N} outlines, tolerance ${notchTol.toFixed(3)}; distance calls ${run.real.board.calls} (board) / ${run.real.native.calls} (native) vs ${run.exhaustive ? `${run.exhaustive.board.calls} / ${run.exhaustive.native.calls} exhaustive` : 'n/a'}`);
console.log(`PASS  dxf-notch-assign-check   ${passed}/${passed} assertions ok`);
