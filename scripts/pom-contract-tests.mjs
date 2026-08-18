#!/usr/bin/env node
// POM 6 / 7 / 8 / 9 / 10 / 16 contract tests.
//
// Runs the auto-mode detector on every demo/*.jpg in headless Chrome and
// checks semantic invariants on the resulting anchors + drafts. Complements
// invariant-tests.mjs (geometric properties) with rule.md-aligned contracts
// for the 6 fragile front-view POMs:
//
//   POM  6: Cradle height at center front      cradle-cf-top  → cf-bottom
//   POM  7: Cradle height at bottom cup        cradle-cup-top → cradle-cup-bottom
//   POM  8: Cup height at center front         cf-top         → cradle-cf-top
//   POM  9: Inner cup height                   inner-cup-top  → inner-cup-bottom
//   POM 10: Inner cup width                    inner-cup-left → inner-cup-right
//   POM 16: Front apex distance                apex-left      → apex-right
//
// Plus CLA.1–CLA.16 (line–anchor coherence): every drawable draft's endpoints
// must sit on the anchor points the TD sees, with the derived offsets
// (POM 2/4 stubs, POM 6 CF x-offset, POM 7/8 forced-vertical end, POM 13
// back-panel fallback) asserted explicitly.
//
// Per-image expectations live in scripts/groundtruth/expectations.json and
// narrow down DRAWABLE / REVIEW_ONLY claims; cross-POM and provenance
// invariants run on every image regardless.
//
//   node scripts/pom-contract-tests.mjs
//   node scripts/pom-contract-tests.mjs --only=demo1
//   node scripts/pom-contract-tests.mjs --verbose
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = parseArgs(process.argv.slice(2));
const chromePath = args.chrome || process.env.CHROME_PATH || DEFAULT_CHROME;
if (!existsSync(chromePath)) fail(`Chrome not found at ${chromePath}. Pass --chrome=/path or set CHROME_PATH.`);

const expectationsPath = path.join(appDir, 'scripts', 'groundtruth', 'expectations.json');
const expectations = existsSync(expectationsPath)
  ? JSON.parse(readFileSync(expectationsPath, 'utf8'))
  : {};

// Rule JSON is the source of truth for the anchor→POM contract (Engineering
// Workflow Phase 7): the P7.* assertions audit captured rows against these
// files, not against copies of their values.
const pomTemplateRules = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules', 'pom-template.json'), 'utf8'));
const ruleVersions = JSON.parse(readFileSync(path.join(appDir, 'auto_mode_rules', 'version.json'), 'utf8'));
const requiredAnchorsForPom = (pom) => {
  const entry = (pomTemplateRules.rows || []).find(r => String(r.id) === String(pom));
  return entry && Array.isArray(entry.requiredAnchors) ? entry.requiredAnchors : [];
};

const images = readdirSync(path.join(appDir, 'demo'))
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .filter(f => !args.only || f.includes(args.only))
  .sort()
  .map(f => `demo/${f}`);
if (!images.length) fail('No demo/*.jpg fixtures found.');

// ---- Assertion definitions ------------------------------------------------
// Each contract: { id, name, require?, test }. `require(c, exp)` skips when
// false; `test(c, exp)` returns { ok, msg }. `exp` is the per-image entry from
// expectations.json (or {} if none).

const EPS_SAME_COL = 0.005;
const EPS_AXIS_PAD = 0.012;
const EPS_SIDE_PAD = 0.010;

const a = (c, k) => c.anchors[k] || null;
const has = (c, ...kinds) => kinds.every(k => a(c, k));

// --- CLA: line–anchor coherence --------------------------------------------
// Every drawable draft's endpoints must sit ON the anchor points the TD sees
// on the board — a line floating off its own anchor dots is a review trap.
// The exceptions are the documented derived offsets, asserted here explicitly
// rather than skipped (mirroring buildPOMFixtureFromAnchors):
//   POM 2/4 — dashed extension stubs: start on the parent's right anchor,
//             end = start + parentLength/5 in x.
//   POM 6   — x = cradle-cf-top.x + halfBand·0.045 (offset off the CF axis so
//             POM 6 reads apart from POM 5); end.y from cf-bottom.
//   POM 7/8 — end.x forced to start.x (strictly vertical by spec).
//   POM 13  — back-panel anchors when seeded, else back-top/bottom + 0.04 x.
// Rows whose endpoints were soft-pulled toward TD-confirmed style evidence
// (styleEvidenceStatus === 'confirmed-prior') intentionally leave the anchors
// and are skipped.
const EPS_LINE_ANCHOR = 0.004;
// The two ends of one horizontal-span pair read the SAME row variable in the
// seeder, so they must be exactly equal — float noise only, not a tolerance.
const EPS_SHARED_ROW = 1e-9;
const g = (c, pom) => (c && c.pomGeom && c.pomGeom[pom]) || null;
const hasLine = (gm) => !!(gm && gm.start && gm.end);
const clamp01n = (v) => Math.max(0, Math.min(1, v));
// Mirrors buildPOMFixtureFromAnchors' at(): missing anchors fall back to the
// image center so derived values (e.g. POM 6's halfBand offset) match the app.
const anchorOr = (c, k) => a(c, k) || { x: 0.5, y: 0.5 };
const nearPt = (p, q) => !!(p && q)
  && Math.abs(p.x - q.x) <= EPS_LINE_ANCHOR
  && Math.abs(p.y - q.y) <= EPS_LINE_ANCHOR;
const fmtPt = (p) => (p ? `(${p.x.toFixed(4)},${p.y.toFixed(4)})` : 'null');
const exactPair = (startKind, endKind) => (c) => (has(c, startKind, endKind)
  ? { start: a(c, startKind), end: a(c, endKind) }
  : null);

// Expected endpoints per POM as a function of the capture's anchors. Returns
// null when the anchors the expectation needs are missing (the missing-anchor
// guard demotes those rows to REVIEW_ONLY anyway).
const CLA_EXPECT = {
  '1': (c) => {
    if (!has(c, 'band-left', 'band-right')) return null;
    const L = a(c, 'band-left'); const R = a(c, 'band-right');
    return { start: L, end: { x: R.x, y: L.y } };
  },
  '2': (c) => {
    if (!has(c, 'band-left', 'band-right')) return null;
    const L = a(c, 'band-left'); const R = a(c, 'band-right');
    return { start: R, end: { x: clamp01n(R.x + (R.x - L.x) / 5), y: R.y } };
  },
  '3': (c) => {
    if (!has(c, 'chest-left', 'chest-right')) return null;
    const L = a(c, 'chest-left'); const R = a(c, 'chest-right');
    return { start: L, end: { x: R.x, y: L.y } };
  },
  '4': (c) => {
    if (!has(c, 'chest-left', 'chest-right')) return null;
    const L = a(c, 'chest-left'); const R = a(c, 'chest-right');
    return { start: R, end: { x: clamp01n(R.x + (R.x - L.x) / 5), y: R.y } };
  },
  '5': exactPair('cf-top', 'cf-bottom'),
  '6': (c) => {
    if (!has(c, 'cradle-cf-top', 'cf-bottom')) return null;
    const cr = a(c, 'cradle-cf-top');
    const halfBand = (anchorOr(c, 'band-right').x - anchorOr(c, 'band-left').x) / 2;
    const x = clamp01n(cr.x + halfBand * 0.045);
    return { start: { x, y: cr.y }, end: { x, y: a(c, 'cf-bottom').y } };
  },
  '7': (c) => {
    if (!has(c, 'cradle-cup-top', 'cradle-cup-bottom')) return null;
    const t = a(c, 'cradle-cup-top');
    return { start: t, end: { x: t.x, y: a(c, 'cradle-cup-bottom').y } };
  },
  '8': (c) => {
    if (!has(c, 'cf-top', 'cradle-cf-top')) return null;
    const t = a(c, 'cf-top');
    return { start: t, end: { x: t.x, y: a(c, 'cradle-cf-top').y } };
  },
  '9': exactPair('inner-cup-top', 'inner-cup-bottom'),
  '10': exactPair('inner-cup-left', 'inner-cup-right'),
  '11': exactPair('side-top', 'side-bottom'),
  '12': exactPair('back-top', 'back-bottom'),
  '13': (c) => {
    if (has(c, 'back-panel-top', 'back-panel-bottom')) {
      return { start: a(c, 'back-panel-top'), end: a(c, 'back-panel-bottom') };
    }
    if (!has(c, 'back-top', 'back-bottom')) return null;
    const t = a(c, 'back-top'); const b = a(c, 'back-bottom');
    return {
      start: { x: clamp01n(t.x + 0.04), y: t.y },
      end: { x: clamp01n(b.x + 0.04), y: b.y },
    };
  },
  '14': exactPair('strap-top', 'strap-bottom'),
  '15': (c) => {
    if (!has(c, 'back-strap-left', 'back-strap-right')) return null;
    const L = a(c, 'back-strap-left'); const R = a(c, 'back-strap-right');
    return { start: L, end: { x: R.x, y: L.y } };
  },
  '16': (c) => {
    if (!has(c, 'apex-left', 'apex-right')) return null;
    const L = a(c, 'apex-left'); const R = a(c, 'apex-right');
    // US-083: apex-left and apex-right are detected independently and the TD
    // legitimately places them at slightly different heights, so the line is
    // levelled at their MIDPOINT rather than at the left end's y — neither pin
    // is favoured. (Too steep a slant demotes the row to REVIEW_ONLY upstream,
    // which skips this assertion via hasLine.)
    const midY = (L.y + R.y) / 2;
    return { start: { x: L.x, y: midY }, end: { x: R.x, y: midY } };
  },
  '17': (c) => {
    // Neckline length: the curve TRACES the neckline edge and its endpoints
    // stay EXACTLY on the measurement anchors 171 (center front) → 172
    // (strap). No parallel offset (that pushed the curve past the top of the
    // front_outer view crop — see generate-pom-fixture POM 17 note).
    if (!has(c, '171', '172')) return null;
    return { start: a(c, '171'), end: a(c, '172') };
  },
  '18': (c) => {
    // Armhole curve: coherence is on the endpoints (start/end), like POM 9/14.
    if (!has(c, '181', '182')) return null;
    return { start: a(c, '181'), end: a(c, '182') };
  },
};

const CLA_NAMES = {
  '1': 'POM 1 line sits on band-left, end forced horizontal (band-right.x at band-left.y)',
  '2': 'POM 2 stub sits on band-right → +1/5 POM 1 length (derived stub)',
  '3': 'POM 3 line sits on chest-left, end forced horizontal (chest-right.x at chest-left.y)',
  '4': 'POM 4 stub sits on chest-right → +1/5 POM 3 length (derived stub)',
  '5': 'POM 5 line sits on cf-top → cf-bottom',
  '6': 'POM 6 line sits on cradle-cf-top / cf-bottom at the +halfBand·0.045 x offset',
  '7': 'POM 7 line sits on cradle-cup-top, end forced vertical to cradle-cup-bottom.y',
  '8': 'POM 8 line sits on cf-top, end forced vertical to cradle-cf-top.y',
  '9': 'POM 9 curve endpoints sit on inner-cup-top → inner-cup-bottom',
  '10': 'POM 10 curve endpoints sit on inner-cup-left → inner-cup-right',
  '11': 'POM 11 line sits on side-top → side-bottom',
  '12': 'POM 12 line sits on back-top → back-bottom',
  '13': 'POM 13 line sits on back-panel anchors (or back-top/bottom + 0.04 x fallback)',
  '14': 'POM 14 curve endpoints sit on strap-top → strap-bottom',
  '15': 'POM 15 line sits on back-strap-left, end forced horizontal (back-strap-right.x at back-strap-left.y)',
  '16': 'POM 16 line spans apex-left → apex-right, levelled at their midpoint height',
  '17': 'POM 17 curve endpoints sit on 171 (center front) → 172 (strap)',
  '18': 'POM 18 curve endpoints sit on armhole-top → armhole-bottom',
};

// One assertion per POM; runs whenever that POM produced a drawable line
// (REVIEW_ONLY rows carry null geometry and skip automatically).
const lineAnchorCoherenceAssertions = () => Object.keys(CLA_EXPECT).map(pom => ({
  id: `CLA.${pom}`,
  name: CLA_NAMES[pom],
  require: (c) => {
    const gm = g(c, pom);
    return hasLine(gm)
      && gm.styleEvidenceStatus !== 'confirmed-prior'
      && !!CLA_EXPECT[pom](c);
  },
  test: (c) => {
    const gm = g(c, pom);
    const want = CLA_EXPECT[pom](c);
    const okS = nearPt(gm.start, want.start);
    const okE = nearPt(gm.end, want.end);
    return {
      ok: okS && okE,
      msg: `start=${fmtPt(gm.start)} want=${fmtPt(want.start)}${okS ? '' : ' ✗'};`
        + ` end=${fmtPt(gm.end)} want=${fmtPt(want.end)}${okE ? '' : ' ✗'}`,
    };
  },
}));

// --- HLN: horizontal-span POMs must be drawn level -------------------------
// POM 1/3 (band / chest widths), 15 (back strap distance) and 16 (apex
// distance) are measured straight ACROSS, so the drafted line must be
// horizontal (start.y === end.y) even when the two anchors sit at slightly
// different heights. buildPOMFixtureFromAnchors forces end.y = start.y for
// these — the mirror of POM 7 / 8's forced-vertical treatment. Skips
// style-evidence-pulled rows (same carve-out as the CLA checks).
const HORIZONTAL_POMS = [
  { pom: '1',  label: 'POM 1 (1/2 bottom band) line is horizontal (start.y === end.y)' },
  { pom: '3',  label: 'POM 3 (1/2 chest) line is horizontal (start.y === end.y)' },
  { pom: '15', label: 'POM 15 (back strap distance) line is horizontal (start.y === end.y)' },
  { pom: '16', label: 'POM 16 (apex distance) line is horizontal (start.y === end.y)' },
];
const horizontalAssertions = () => HORIZONTAL_POMS.map(({ pom, label }) => ({
  id: `HLN.${pom}`,
  name: label,
  require: (c) => {
    const gm = g(c, pom);
    return hasLine(gm) && gm.styleEvidenceStatus !== 'confirmed-prior';
  },
  test: (c) => {
    const gm = g(c, pom);
    const dy = Math.abs(gm.start.y - gm.end.y);
    return { ok: dy < EPS_SAME_COL, msg: `|Δy|=${dy.toFixed(4)}` };
  },
}));

// --- TRA: the drawn line must pass through BOTH required anchors -----------
// The CLA series above recomputes the drafter's own formula and compares — so
// for a force-levelled span it asserts `end = (R.x, L.y)`, i.e. it reproduces
// the discard of R.y and can never fail on it. That blind spot let a real
// defect ship: when the seeder put the two ends of one row at different
// heights, POM 1/3 drew level at L.y and missed the right-hand pin entirely
// while CLA stayed green (all 21 golden fixtures happened to seed the pair
// level, so the corpus never exercised it either).
//
// TRA asserts the property a TD actually cares about, independent of the
// formula: the point-to-SEGMENT distance from each required anchor to the drawn
// line is within tolerance. Force-levelling stays legal — it only has to keep
// the line on both pins, which it does exactly when the pair shares a row.
//
// POM 16 is deliberately NOT in this list. Its two anchors are detected
// independently and the TD ground truth legitimately places them at different
// heights, so a levelled line CANNOT touch both — it sits half the gap from
// each by design. APX below asserts that midpoint property instead.
const distToSegment = (p, s, e) => {
  const vx = e.x - s.x;
  const vy = e.y - s.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - s.x, p.y - s.y);
  let t = ((p.x - s.x) * vx + (p.y - s.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (s.x + t * vx), p.y - (s.y + t * vy));
};
// --- RPF: one-sided seeding still yields ONE row --------------------------
// The corpus only ever detects band/chest ink on both sides, so the branch
// where one side falls back to a view-box ratio is unreachable from any
// fixture — and that is precisely the branch where the two ends of a row used
// to land at different heights, throwing POM 1-4 off anchors that still
// rendered correctly. captureExpr re-seeds that branch explicitly; these
// assertions check the result.
const RPF_CASES = [
  { key: 'band-right-missing',  label: 'band row, right ink missing' },
  { key: 'band-left-missing',   label: 'band row, left ink missing' },
  { key: 'band-both-missing',   label: 'band row, no ink either side' },
  { key: 'chest-right-missing', label: 'chest row, right ink missing' },
  { key: 'chest-left-missing',  label: 'chest row, left ink missing' },
  { key: 'chest-both-missing',  label: 'chest row, no ink either side' },
];
const rowPairFallbackAssertions = () => RPF_CASES.map(({ key, label }) => ({
  id: `RPF.${key}`,
  name: `${label}: pair shares one row and POM line stays on both anchors`,
  require: (c) => !!(c.rowPairs && Object.keys(c.rowPairs).length),
  test: (c) => {
    const r = c.rowPairs[key];
    if (!r) return { ok: false, msg: `no capture for ${key} — the re-seed never ran` };
    if (r.error) return { ok: false, msg: `re-seed threw: ${r.error}` };
    if (!r.left || !r.right) return { ok: false, msg: `${key}: pair anchors missing after re-seed` };
    if (!r.line) return { ok: false, msg: `${key}: POM ${r.pom} produced no line after re-seed` };
    const dy = Math.abs(r.left.y - r.right.y);
    const problems = [];
    if (dy > EPS_SHARED_ROW) {
      problems.push(`pair split across rows: left.y=${r.left.y.toFixed(6)}`
        + ` right.y=${r.right.y.toFixed(6)} dy=${dy.toFixed(6)}`
        + ` — POM ${r.pom} draws level at left.y and would miss the right anchor by dy`);
    }
    // Sharing a row is not enough — it must be the DETECTED row, otherwise both
    // ends could agree on a wrong one.
    if (r.detectedRow != null && Math.abs(r.left.y - r.detectedRow) > EPS_SHARED_ROW) {
      problems.push(`row is ${r.left.y.toFixed(6)} but detection resolved ${r.detectedRow.toFixed(6)}`);
    }
    const gapL = distToSegment(r.left, r.line.start, r.line.end);
    const gapR = distToSegment(r.right, r.line.start, r.line.end);
    if (gapL > EPS_LINE_ANCHOR || gapR > EPS_LINE_ANCHOR) {
      problems.push(`POM ${r.pom} line gaps left=${gapL.toFixed(4)} right=${gapR.toFixed(4)}`
        + ` (need <= ${EPS_LINE_ANCHOR})`);
    }
    return {
      ok: problems.length === 0,
      msg: problems.length ? problems.join('; ')
        : `dy=${dy.toFixed(6)}, line gaps ${gapL.toFixed(4)}/${gapR.toFixed(4)}`,
    };
  },
}));

// --- APX: POM 16 splits the difference between its two apex pins ------------
// The apex pair is not one row (see CLA_EXPECT['16']), so "touches both" is the
// wrong contract. The right one is that the levelled line favours NEITHER pin:
// it must be equidistant from both, and that distance must be exactly half the
// pair's height gap. Before US-083 the line sat ON apex-left and the full gap
// away from apex-right — which is what this catches.
const apexAssertions = () => [{
  id: 'APX.16',
  name: 'POM 16 line is levelled at the midpoint of both apex pins',
  require: (c) => {
    const gm = g(c, '16');
    return hasLine(gm) && gm.styleEvidenceStatus !== 'confirmed-prior'
      && has(c, 'apex-left', 'apex-right');
  },
  test: (c) => {
    const gm = g(c, '16');
    const L = a(c, 'apex-left');
    const R = a(c, 'apex-right');
    const gapL = distToSegment(L, gm.start, gm.end);
    const gapR = distToSegment(R, gm.start, gm.end);
    const halfSpread = Math.abs(L.y - R.y) / 2;
    const problems = [];
    if (Math.abs(gapL - gapR) > EPS_LINE_ANCHOR) {
      problems.push(`line favours one pin: gapL=${gapL.toFixed(4)} gapR=${gapR.toFixed(4)}`);
    }
    if (Math.abs(Math.max(gapL, gapR) - halfSpread) > EPS_LINE_ANCHOR) {
      problems.push(`gap ${Math.max(gapL, gapR).toFixed(4)} is not half the`
        + ` ${(halfSpread * 2).toFixed(4)} apex height spread`);
    }
    return {
      ok: problems.length === 0,
      msg: problems.length ? problems.join('; ')
        : `gaps ${gapL.toFixed(4)}/${gapR.toFixed(4)}, half-spread ${halfSpread.toFixed(4)}`,
    };
  },
}];

const TOUCH_POMS = [
  { pom: '1',  kinds: ['band-left', 'band-right'] },
  { pom: '3',  kinds: ['chest-left', 'chest-right'] },
  { pom: '15', kinds: ['back-strap-left', 'back-strap-right'] },
];
const touchesRequiredAnchorAssertions = () => TOUCH_POMS.map(({ pom, kinds }) => ({
  id: `TRA.${pom}`,
  name: `POM ${pom} line passes through both anchors (${kinds.join(' + ')})`,
  require: (c) => {
    const gm = g(c, pom);
    return hasLine(gm) && gm.styleEvidenceStatus !== 'confirmed-prior' && has(c, ...kinds);
  },
  test: (c) => {
    const gm = g(c, pom);
    const parts = kinds.map((kind) => {
      const anchor = a(c, kind);
      const d = distToSegment(anchor, gm.start, gm.end);
      return { kind, d, ok: d <= EPS_LINE_ANCHOR };
    });
    return {
      ok: parts.every(p => p.ok),
      msg: parts.map(p => `${p.kind} gap=${p.d.toFixed(4)}${p.ok ? '' : ' ✗'}`).join('; ')
        + ` (need <= ${EPS_LINE_ANCHOR})`,
    };
  },
}));

const ASSERTIONS = [
  // --- POM 6: Cradle height at center front --------------------------------
  {
    id: 'C6.vertical', name: 'POM 6 endpoints share column',
    require: (c) => has(c, 'cradle-cf-top', 'cf-bottom'),
    test: (c) => {
      const dx = Math.abs(a(c, 'cradle-cf-top').x - a(c, 'cf-bottom').x);
      return { ok: dx < EPS_SAME_COL, msg: `|Δx|=${dx.toFixed(4)}` };
    },
  },
  {
    id: 'C6.start-above-end', name: 'POM 6 start (cradle-cf-top) above end (cf-bottom)',
    require: (c) => has(c, 'cradle-cf-top', 'cf-bottom'),
    test: (c) => {
      const top = a(c, 'cradle-cf-top').y;
      const bot = a(c, 'cf-bottom').y;
      return { ok: top < bot, msg: `start.y=${top.toFixed(4)} end.y=${bot.toFixed(4)}` };
    },
  },
  {
    id: 'C6.start-on-axis', name: 'POM 6 start near symmetry axis',
    require: (c) => has(c, 'cradle-cf-top') && c.axisX != null,
    test: (c) => {
      const d = Math.abs(a(c, 'cradle-cf-top').x - c.axisX);
      return { ok: d < EPS_AXIS_PAD, msg: `|x − axisX|=${d.toFixed(4)}` };
    },
  },
  {
    id: 'C6.td-placement', name: 'POM 6 start matches TD-approved fixture range',
    require: (c, exp) => has(c, 'cradle-cf-top')
      && Array.isArray(exp.cradleCfTopYRange)
      && exp.cradleCfTopYRange.length === 2,
    test: (c, exp) => {
      const y = a(c, 'cradle-cf-top').y;
      const lo = Number(exp.cradleCfTopYRange[0]);
      const hi = Number(exp.cradleCfTopYRange[1]);
      return { ok: Number.isFinite(lo) && Number.isFinite(hi) && y >= lo && y <= hi,
        msg: `y=${y.toFixed(4)} expected=[${lo.toFixed(4)},${hi.toFixed(4)}]` };
    },
  },
  {
    id: 'C6.seam-source', name: 'POM 6 cradle-cf-top is seam-derived (direct seam, or projected-from-seam when flagged for review)',
    require: (c) => has(c, 'cradle-cf-top'),
    test: (c) => {
      const anc = a(c, 'cradle-cf-top');
      const src = anc.source;
      // 'seam' = direct CF-seam ink (the trusted case). 'seamProjected' = the
      // bottom-cup cradle seam (POM 7 top) projected onto the CF axis when the
      // direct detector missed (seed-anchors cradleCfFromCupSeam rescue).
      // 'seamDip' = the direct CF-seam detector proved a real cradle seam that
      // CROSSES the CF axis symmetrically but dips (no ink) inside the narrow
      // center-front gore, so its CF endpoint is projected onto the axis at the
      // cradle row (auto-detection cradleCfTopDipProjected path). Both projected
      // sources are allowed ONLY when the anchor is flagged for review, so an
      // approximate placement is never silently trusted. A bare
      // 'ratio'/'silhouette' guess is still rejected.
      // 'seamJunction' (US-015: seam meets a CF closure placket) and
      // 'seamCrest' (US-015: symmetric gore-top crest from contours) are
      // review-flagged recovery tiers like the projected sources.
      const ok = src === 'seam'
        || ((src === 'seamProjected' || src === 'seamDip'
             || src === 'seamJunction' || src === 'seamCrest')
            && anc.reviewRequired === true);
      return { ok, msg: `source=${src} reviewRequired=${anc.reviewRequired}` };
    },
  },
  {
    id: 'C6.shorter-than-pom5', name: 'POM 6 length < POM 5 length',
    require: (c) => has(c, 'cradle-cf-top', 'cf-top', 'cf-bottom'),
    test: (c) => {
      const len6 = a(c, 'cf-bottom').y - a(c, 'cradle-cf-top').y;
      const len5 = a(c, 'cf-bottom').y - a(c, 'cf-top').y;
      return { ok: len6 > 0 && len6 < len5, msg: `len6=${len6.toFixed(4)} len5=${len5.toFixed(4)}` };
    },
  },

  // --- POM 7: Cradle height at bottom cup ----------------------------------
  {
    id: 'C7.anchor-presence', name: 'POM 7 anchors only seeded when both endpoints exist',
    test: (c) => {
      const top = a(c, 'cradle-cup-top');
      const bot = a(c, 'cradle-cup-bottom');
      const both = !!(top && bot);
      const neither = !top && !bot;
      return { ok: both || neither, msg: `top=${!!top} bottom=${!!bot}` };
    },
  },
  {
    id: 'C7.start-off-cf', name: 'POM 7 start away from CF axis (rule.md bottomCupZone)',
    require: (c) => has(c, 'cradle-cup-top') && c.axisX != null,
    test: (c) => {
      const d = Math.abs(a(c, 'cradle-cup-top').x - c.axisX);
      return { ok: d > EPS_AXIS_PAD * 4, msg: `|x − axisX|=${d.toFixed(4)}` };
    },
  },
  {
    id: 'C7.start-off-side-seam', name: 'POM 7 start not on side seam (within 1% bbox width)',
    require: (c) => has(c, 'cradle-cup-top'),
    test: (c) => {
      // The detector enforces a 5% bboxW reject for pattern-3 (no guide line)
      // candidates. Pattern-1/2 (explicit guide) candidates can legitimately
      // sit closer to the side seam — assert only "not literally on top".
      const x = a(c, 'cradle-cup-top').x;
      const dL = c.sideLeftX != null  ? Math.abs(x - c.sideLeftX)  : Infinity;
      const dR = c.sideRightX != null ? Math.abs(x - c.sideRightX) : Infinity;
      const d = Math.min(dL, dR);
      return { ok: d > EPS_SIDE_PAD, msg: `min(|x − sideL|, |x − sideR|)=${d.toFixed(4)}` };
    },
  },
  {
    id: 'C7.vertical', name: 'POM 7 endpoints share column',
    require: (c) => has(c, 'cradle-cup-top', 'cradle-cup-bottom'),
    test: (c) => {
      const dx = Math.abs(a(c, 'cradle-cup-top').x - a(c, 'cradle-cup-bottom').x);
      return { ok: dx < EPS_SAME_COL, msg: `|Δx|=${dx.toFixed(4)}` };
    },
  },
  {
    id: 'C7.seam-source', name: 'POM 7 anchors are seam-sourced (direct seam, or guide-tier when flagged for review)',
    require: (c) => has(c, 'cradle-cup-top'),
    test: (c) => {
      // 'seam' = strong-guide or pattern-3 acceptance (the trusted case).
      // 'seamGuide' = the ADR 0021 sparse-dashed tier; 'seamArc' = the ADR
      // 0022 traced cup-bottom arc tier. Both acceptable ONLY when the anchor
      // is flagged for TD review (mirrors C6.seam-source's projected clause).
      // Neither feeds the cupModel.
      const anc = a(c, 'cradle-cup-top');
      const src = anc.source;
      const ok = src === 'seam'
        || ((src === 'seamGuide' || src === 'seamArc') && anc.reviewRequired === true);
      return { ok, msg: `source=${src} reviewRequired=${anc.reviewRequired}` };
    },
  },
  {
    id: 'C7.review-when-no-seam', name: 'POM 7 REVIEW_ONLY when cradle-cup-seam absent (per expectations)',
    require: (_c, exp) => exp && exp.hasCradleCupSeam === false,
    test: (c) => {
      const p = c.poms['7'];
      return { ok: !p || p.drawability === 'REVIEW_ONLY', msg: `pom7=${p && p.drawability}` };
    },
  },

  // --- POM 8: Cup height at center front -----------------------------------
  {
    id: 'C8.start-above-end', name: 'POM 8 cf-top above cradle-cf-top',
    require: (c) => has(c, 'cf-top', 'cradle-cf-top'),
    test: (c) => {
      const top = a(c, 'cf-top').y;
      const end = a(c, 'cradle-cf-top').y;
      return { ok: top < end, msg: `cf-top.y=${top.toFixed(4)} cradle-cf-top.y=${end.toFixed(4)}` };
    },
  },
  {
    id: 'C8.end-not-band', name: 'POM 8 end is NOT band baseline (must be cradle-cf, not cf-bottom)',
    require: (c) => has(c, 'cradle-cf-top') && c.bandY != null,
    test: (c) => {
      const d = c.bandY - a(c, 'cradle-cf-top').y;
      return { ok: d > EPS_AXIS_PAD, msg: `bandY − cradle.y=${d.toFixed(4)}` };
    },
  },
  {
    id: 'C8.shorter-than-pom5', name: 'POM 8 length < POM 5 length (cup height < full CF height)',
    require: (c) => has(c, 'cf-top', 'cradle-cf-top', 'cf-bottom'),
    test: (c) => {
      const len8 = a(c, 'cradle-cf-top').y - a(c, 'cf-top').y;
      const len5 = a(c, 'cf-bottom').y - a(c, 'cf-top').y;
      return { ok: len8 > 0 && len8 < len5, msg: `len8=${len8.toFixed(4)} len5=${len5.toFixed(4)}` };
    },
  },
  {
    id: 'C8.end-equals-pom6-start', name: 'POM 8 end ≡ POM 6 start (same anchor: cradle-cf-top)',
    require: (c) => has(c, 'cradle-cf-top'),
    test: () => ({ ok: true, msg: 'shared by construction (Auto Mode JSON rules)' }),
  },

  // --- POM 9: Inner cup height ---------------------------------------------
  {
    id: 'C9.shares-cup-with-10', name: 'POM 9 and POM 10 read the SAME cup model',
    require: (c) => has(c, 'inner-cup-top', 'inner-cup-left'),
    test: (c) => {
      const id9 = a(c, 'inner-cup-top').cupModelId;
      const id10 = a(c, 'inner-cup-left').cupModelId;
      return { ok: !!id9 && id9 === id10, msg: `cupId9=${id9} cupId10=${id10}` };
    },
  },
  {
    id: 'C9.view-role-coherent', name: 'POM 9 and POM 10 share viewRole',
    require: (c) => has(c, 'inner-cup-top', 'inner-cup-left'),
    test: (c) => {
      const r9 = a(c, 'inner-cup-top').viewRole;
      const r10 = a(c, 'inner-cup-left').viewRole;
      return { ok: r9 === r10, msg: `role9=${r9} role10=${r10}` };
    },
  },
  {
    id: 'C9.no-false-review-without-front-inner',
    name: 'POM 9 front cup is NOT flagged for review merely because a front_inner view is absent',
    // Runs on the normal front+back sketch (no inner cutaway). The guard uses
    // `< 0` because det.frontInnerViewIndex is -1 (a number), not null, when
    // absent — the old `== null` guard silently skipped every demo, so this
    // check was dormant. Inverted per DETECTION_AND_MEASUREMENT_CONTRACT.md P1:
    // absence of an inner cutaway is normal, not a fault.
    require: (c) => (c.frontInnerViewIndex == null || c.frontInnerViewIndex < 0)
                    && has(c, 'inner-cup-top') && c.cupModel,
    test: (c) => {
      const top = a(c, 'inner-cup-top');
      const p9 = c.poms && c.poms['9'];
      const vis = c.cupModel.visibility;
      // A directly-read front cup (real apex + real cup-bottom) is full
      // confidence: source 'cupModel', NOT reviewRequired, tier not 'low',
      // POM 9 DRAWABLE — even with no front_inner cutaway. Exception: when
      // the model's inner edge is UNSUPPORTED (its width row crosses an open
      // neckline V and the gore-inset endpoint floats in blank background —
      // front-closure styles whose apex fires on the strap top), the QA layer
      // deliberately refuses the cupModel path and review IS warranted; that
      // case is judged by the weak branch below.
      if (vis === 'direct' && c.cupModel.innerEdgeSupported !== false) {
        const ok = top.source === 'cupModel'
          && top.reviewRequired === false
          && top.confidence !== 'low'
          && !!p9 && p9.drawability === 'DRAWABLE';
        return { ok, msg: `direct cup trusted w/o front_inner: src=${top.source} rr=${top.reviewRequired} conf=${top.confidence} draw=${p9 && p9.drawability}` };
      }
      // A genuinely inferred/weak cup MAY be flagged; a low-tier one MUST be.
      const ok = top.confidence !== 'low' || top.reviewRequired;
      return { ok, msg: `vis=${vis} src=${top.source} rr=${top.reviewRequired} conf=${top.confidence}` };
    },
  },

  // --- POM 10: Inner cup width ---------------------------------------------
  {
    id: 'C10.shares-cup-with-9', name: 'POM 10 anchors share cupModelId across left/right',
    require: (c) => has(c, 'inner-cup-left', 'inner-cup-right'),
    test: (c) => {
      const idL = a(c, 'inner-cup-left').cupModelId;
      const idR = a(c, 'inner-cup-right').cupModelId;
      return { ok: !!idL && idL === idR, msg: `idL=${idL} idR=${idR}` };
    },
  },

  // --- POM 14: shoulder strap length, front strap seam → back strap end -----
  // POM 14 is the curved strap length: front strap upper joining seam
  // (strap-top) to the end of the shoulder strap at the back (strap-bottom).
  {
    id: 'C14.front-to-back-anchors', name: 'POM 14 uses front strap upper join and back strap end',
    require: (c) => has(c, 'strap-top', 'strap-bottom'),
    test: (c) => {
      const startRole = a(c, 'strap-top').viewRole;
      const endRole = a(c, 'strap-bottom').viewRole;
      return { ok: startRole === 'front_outer' && endRole === 'back', msg: `strap-top=${startRole} strap-bottom=${endRole}` };
    },
  },
  {
    id: 'C14.curved', name: 'POM 14 is a curved strap-length line',
    require: (c) => c.pomGeom && c.pomGeom['14'] && c.pomGeom['14'].drawability !== 'REVIEW_ONLY',
    test: (c) => {
      const g = c.pomGeom['14'];
      return { ok: g.type === 'curved', msg: `type=${g.type}` };
    },
  },
  {
    id: 'C14.source-front-join-back-end', name: 'POM 14 sources front strap seam and back panel join',
    require: (c) => has(c, 'strap-top', 'strap-bottom'),
    test: (c) => {
      const st = a(c, 'strap-top').source;
      const sb = a(c, 'strap-bottom').source;
      const okT = st === 'frontStrapSeam' || st === 'ratio';
      const okB = sb === 'backPanelJoin' || sb === 'ratio';
      return { ok: okT && okB, msg: `strap-top=${st} strap-bottom=${sb}` };
    },
  },
  {
    id: 'C14.never-high', name: 'POM 14 draft and back end remain low/reviewRequired (always-verify POM)',
    require: (c) => has(c, 'strap-top', 'strap-bottom'),
    test: (c) => {
      const T = a(c, 'strap-top');
      const B = a(c, 'strap-bottom');
      const p = c.poms && c.poms['14'];
      const ok = !!p && p.confidence === 'low' && B.confidence !== 'high' && B.reviewRequired;
      return {
        ok,
        msg: `pom14=${p && p.confidence} strap-top=${T.confidence}/rr=${T.reviewRequired} strap-bottom=${B.confidence}/rr=${B.reviewRequired}`,
      };
    },
  },
  {
    id: 'C14.review-when-front-only', name: 'POM 14 REVIEW_ONLY on a front-only sketch (no back strap end)',
    // Guard on view COUNT, not backViewIndex: seed-anchors falls back to the
    // largest non-front view whenever >1 view exists, so straps seed on any
    // 2-view sketch regardless of the classifier's back-role index. Only a
    // single-view sketch genuinely cannot source them.
    require: (c) => c.viewCount != null && c.viewCount <= 1,
    test: (c) => {
      const p = c.poms && c.poms['14'];
      const noBackEnd = !a(c, 'strap-bottom');
      return {
        ok: (!p || p.drawability === 'REVIEW_ONLY') && noBackEnd,
        msg: `pom14=${p && p.drawability} strapTop=${!!a(c, 'strap-top')} strapBottom=${!!a(c, 'strap-bottom')}`,
      };
    },
  },

  // --- POM 16: Front apex distance -----------------------------------------
  {
    id: 'C16.both-sides', name: 'POM 16 apex anchors come in left/right pairs',
    test: (c) => {
      const L = a(c, 'apex-left');
      const R = a(c, 'apex-right');
      const both = L && R;
      const neither = !L && !R;
      return { ok: both || neither, msg: `L=${!!L} R=${!!R}` };
    },
  },
  {
    id: 'C16.left-right-order', name: 'POM 16 apex-left.x < apex-right.x',
    require: (c) => has(c, 'apex-left', 'apex-right'),
    test: (c) => {
      const lx = a(c, 'apex-left').x;
      const rx = a(c, 'apex-right').x;
      return { ok: lx < rx, msg: `L.x=${lx.toFixed(4)} R.x=${rx.toFixed(4)}` };
    },
  },
  {
    id: 'C16.both-above-chest', name: 'POM 16 apex anchors above chest row',
    require: (c) => has(c, 'apex-left', 'apex-right') && c.chestY != null,
    test: (c) => {
      const lOK = a(c, 'apex-left').y  < c.chestY + 0.05;
      const rOK = a(c, 'apex-right').y < c.chestY + 0.05;
      return { ok: lOK && rOK, msg: `L.y=${a(c, 'apex-left').y.toFixed(4)} R.y=${a(c, 'apex-right').y.toFixed(4)} chestY=${c.chestY.toFixed(4)}` };
    },
  },
  {
    id: 'C16.source-cup-curve', name: 'POM 16 apex source is cup-curve, never strap-ring hardware',
    require: (c) => has(c, 'apex-left', 'apex-right'),
    test: (c) => {
      const sL = a(c, 'apex-left').source;
      const sR = a(c, 'apex-right').source;
      const ok = sL === 'apexJoin' && sR === 'apexJoin';
      const apexJoin = c.apexJoin || null;
      const aj = apexJoin && apexJoin.left && apexJoin.right
        ? `left.source=${apexJoin.left.source} right.source=${apexJoin.right.source}`
        : '(no apexJoin payload)';
      return { ok, msg: `anchor sources L=${sL} R=${sR}; ${aj}` };
    },
  },
  {
    id: 'C16.not-strap-ring', name: 'POM 16 apexJoin.source !== "strap-ring"',
    require: (c) => c.apexJoin && (c.apexJoin.left || c.apexJoin.right),
    test: (c) => {
      const sL = c.apexJoin.left ? c.apexJoin.left.source : null;
      const sR = c.apexJoin.right ? c.apexJoin.right.source : null;
      const ok = sL !== 'strap-ring' && sR !== 'strap-ring';
      return { ok, msg: `apexJoin.left.source=${sL} apexJoin.right.source=${sR}` };
    },
  },

  // --- P6: landmark QA layer (Engineering Workflow Phase 6) ------------------
  // The detection must carry a first-class landmark layer, and the seeded
  // anchors must agree with it — a weak landmark can never become a confident
  // anchor through table drift between the two.
  {
    id: 'P6.layer-present', name: 'detection.landmarkQa covers every anchor-schema kind',
    test: (c) => {
      const lq = c.landmarkQa;
      if (!lq || !lq.byKind) return { ok: false, msg: 'landmarkQa missing from detection' };
      const missingEntries = Object.keys(c.anchors).filter(k => !lq.byKind[k]);
      const ok = missingEntries.length === 0 && lq.summary && lq.summary.total >= Object.keys(lq.byKind).length;
      return { ok, msg: `kinds=${Object.keys(lq.byKind).length} uncovered=[${missingEntries.join(',')}]` };
    },
  },
  {
    id: 'P6.anchor-consistency', name: 'seeded anchors carry the landmark QA verdicts (tier/source/review)',
    require: (c) => !!(c.landmarkQa && c.landmarkQa.byKind),
    test: (c) => {
      const lq = c.landmarkQa.byKind;
      const bad = [];
      for (const [kind, anc] of Object.entries(c.anchors)) {
        const q = lq[kind];
        if (!q) continue; // P6.layer-present already fails on this
        if (anc.confidence !== q.confidence) bad.push(`${kind}: tier ${anc.confidence}!=${q.confidence}`);
        if (anc.source !== q.source) bad.push(`${kind}: source ${anc.source}!=${q.source}`);
        if (anc.reviewRequired !== q.reviewRequired) bad.push(`${kind}: rr ${anc.reviewRequired}!=${q.reviewRequired}`);
        const expectedClass = anc.calibrated ? 'learned' : q.sourceClass;
        if (anc.landmarkSourceClass !== expectedClass) bad.push(`${kind}: class ${anc.landmarkSourceClass}!=${expectedClass}`);
      }
      return { ok: bad.length === 0, msg: bad.length ? bad.slice(0, 4).join('; ') : 'all seeded anchors agree with landmarkQa' };
    },
  },
  {
    id: 'P6.presence-consistency', name: 'landmark `missing` ⇔ anchor not seeded (both directions)',
    require: (c) => !!(c.landmarkQa && c.landmarkQa.byKind),
    test: (c) => {
      const bad = [];
      for (const [kind, q] of Object.entries(c.landmarkQa.byKind)) {
        const seeded = !!c.anchors[kind];
        if (q.sourceClass === 'missing' && seeded) bad.push(`${kind}: classified missing but seeded`);
        if (q.sourceClass !== 'missing' && !seeded) bad.push(`${kind}: classified ${q.sourceClass} but not seeded`);
      }
      return { ok: bad.length === 0, msg: bad.length ? bad.join('; ') : 'presence agrees for all kinds' };
    },
  },
  {
    id: 'P6.source-class-enum', name: 'landmark source classes stay in the Phase 6 vocabulary',
    require: (c) => !!(c.landmarkQa && c.landmarkQa.byKind),
    test: (c) => {
      const allowed = new Set(['detected', 'derived', 'projected', 'missing']);
      const bad = Object.values(c.landmarkQa.byKind)
        .filter(q => !allowed.has(q.sourceClass))
        .map(q => `${q.kind}=${q.sourceClass}`);
      const badAnchor = Object.entries(c.anchors)
        .filter(([, a]) => a.landmarkSourceClass && !allowed.has(a.landmarkSourceClass) && a.landmarkSourceClass !== 'learned')
        .map(([k, a]) => `${k}=${a.landmarkSourceClass}`);
      return { ok: bad.length === 0 && badAnchor.length === 0, msg: [...bad, ...badAnchor].join('; ') || 'all classes valid' };
    },
  },
  {
    id: 'P6.weak-never-confident', name: 'no low-tier or projected landmark escapes reviewRequired',
    require: (c) => !!(c.landmarkQa && c.landmarkQa.byKind),
    test: (c) => {
      const bad = Object.values(c.landmarkQa.byKind)
        .filter(q => q.present && (q.confidence === 'low' || q.sourceClass === 'projected') && !q.reviewRequired)
        .map(q => q.kind);
      return { ok: bad.length === 0, msg: bad.length ? `escaped review: ${bad.join(',')}` : 'all weak landmarks flagged' };
    },
  },
  {
    id: 'P6.pom14-always-verify', name: 'POM 14 strap landmarks stay always-verify with a QA note',
    require: (c) => !!(c.landmarkQa && c.landmarkQa.byKind),
    test: (c) => {
      const T = c.landmarkQa.byKind['strap-top'];
      const B = c.landmarkQa.byKind['strap-bottom'];
      const noted = (q) => !!(q && Array.isArray(q.notes) && q.notes.some(n => n.indexOf('POM 14') === 0 || n.indexOf('missing') === 0));
      const ok = !!T && !!B && T.reviewRequired === true && B.reviewRequired === true && noted(T) && noted(B);
      return { ok, msg: `strap-top rr=${T && T.reviewRequired} strap-bottom rr=${B && B.reviewRequired}` };
    },
  },

  // --- P7: anchor→POM contract stabilization (Engineering Workflow Phase 7) --
  // The boundary must stay auditable: anchors normalized [0,1], rows stamped
  // with the rule-JSON versions, and every REVIEW_ONLY row explaining itself
  // with accurate missing-anchor lists and landmark-QA notes.
  {
    id: 'P7.anchors-normalized', name: 'every anchor sits inside normalized [0,1]',
    test: (c) => {
      const bad = Object.entries(c.anchors)
        .filter(([, a]) => !(a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1))
        .map(([k, a]) => `${k}(${a.x.toFixed(3)},${a.y.toFixed(3)})`);
      return { ok: bad.length === 0, msg: bad.join('; ') || `all ${Object.keys(c.anchors).length} anchors in range` };
    },
  },
  {
    id: 'P7.rule-versions-stamped', name: 'draft rows carry the rule-JSON template/rule versions',
    test: (c) => {
      const bad = Object.entries(c.poms)
        .filter(([, p]) => p.templateVersion !== ruleVersions.template_version
          || p.ruleVersion !== ruleVersions.rule_version)
        .map(([pom, p]) => `POM ${pom}: ${p.templateVersion}/${p.ruleVersion}`);
      return {
        ok: bad.length === 0,
        msg: bad.length ? bad.slice(0, 3).join('; ') : `all rows ${ruleVersions.template_version} / ${ruleVersions.rule_version}`,
      };
    },
  },
  {
    id: 'P7.review-only-explains', name: 'every REVIEW_ONLY row carries a non-empty uncertainty',
    test: (c) => {
      const bad = Object.entries(c.poms)
        .filter(([, p]) => p.drawability === 'REVIEW_ONLY' && !(typeof p.uncertainty === 'string' && p.uncertainty.length))
        .map(([pom]) => `POM ${pom}`);
      return { ok: bad.length === 0, msg: bad.join('; ') || 'all review-only rows explain themselves' };
    },
  },
  {
    id: 'P7.missing-anchors-accurate', name: 'missingAnchors matches reality and the template contract',
    test: (c) => {
      const bad = [];
      for (const [pom, p] of Object.entries(c.poms)) {
        const required = requiredAnchorsForPom(pom);
        const actuallyMissing = required.filter(k => !c.anchors[k]);
        // A required anchor genuinely absent ⇒ row demoted AND listed.
        if (actuallyMissing.length) {
          if (p.drawability !== 'REVIEW_ONLY') bad.push(`POM ${pom}: required ${actuallyMissing.join(',')} missing but drawability=${p.drawability}`);
          for (const k of actuallyMissing) {
            if (!p.missingAnchors || p.missingAnchors.indexOf(k) < 0) bad.push(`POM ${pom}: missing ${k} not listed in missingAnchors`);
          }
        }
        // Every listed kind must be genuinely missing and template-declared.
        for (const k of (p.missingAnchors || [])) {
          if (c.anchors[k]) bad.push(`POM ${pom}: missingAnchors lists ${k} but it was seeded`);
          if (required.indexOf(k) < 0) bad.push(`POM ${pom}: missingAnchors lists ${k} which is not a requiredAnchor`);
        }
      }
      return { ok: bad.length === 0, msg: bad.length ? bad.slice(0, 4).join('; ') : 'missing-anchor lists accurate' };
    },
  },
  {
    id: 'P7.review-notes-from-qa', name: 'guard-demoted rows carry landmark-QA review notes',
    require: (c) => !!(c.landmarkQa && c.landmarkQa.byKind),
    test: (c) => {
      const bad = [];
      for (const [pom, p] of Object.entries(c.poms)) {
        if (p.drawability !== 'REVIEW_ONLY' || !p.missingAnchors || !p.missingAnchors.length) continue;
        const qaHasNotes = p.missingAnchors.some(k => {
          const q = c.landmarkQa.byKind[k];
          return q && Array.isArray(q.notes) && q.notes.length;
        });
        if (qaHasNotes && !(p.reviewNotes && p.reviewNotes.length)) {
          bad.push(`POM ${pom}: QA has notes for ${p.missingAnchors.join(',')} but reviewNotes is empty`);
        }
      }
      return { ok: bad.length === 0, msg: bad.join('; ') || 'review notes propagate from landmark QA' };
    },
  },

  // --- CLA: drafted line endpoints sit on their anchor points ---------------
  ...lineAnchorCoherenceAssertions(),

  // --- Horizontal-span POMs (1 / 3 / 15 / 16) must be drawn level ----------
  ...horizontalAssertions(),

  // --- TRA: the drawn line must actually TOUCH both required anchors -------
  ...touchesRequiredAnchorAssertions(),

  // --- RPF: the one-sided seeding branch no fixture can reach on its own ---
  ...rowPairFallbackAssertions(),

  // --- APX: POM 16 is levelled at the midpoint of its two apex pins --------
  ...apexAssertions(),
];

// ---- Run -----------------------------------------------------------------
let chrome; let server; let userDataDir;
const captures = {};
const errors = {};

try {
  const { server: httpServer, baseUrl } = await startStaticServer(appDir);
  server = httpServer;
  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-contract-'));
  const targetUrl = `${baseUrl}/index.html?contract=${Date.now()}&freeCv=1`;
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    // ?freeCv=1 in the target URL pins the deterministic free path
    // (opencv.js is vendored same-origin now; the resolver rule is legacy).
    '--host-resolver-rules=MAP docs.opencv.org 127.0.0.1:9',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, targetUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const target = await waitForChromeTarget(cdpPort, targetUrl);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  for (const image of images) {
    try {
      await cdp.send('Page.navigate', { url: targetUrl });
      await waitForDebugApi(cdp);
      captures[image] = await withTimeout(evaluate(cdp, captureExpr(image)), 60000, image);
      if (args.verbose) {
        const c = captures[image];
        console.error(`[${image}] captured. visibility=${c.cupModel ? c.cupModel.visibility : '-'} frontInnerViewIndex=${c.frontInnerViewIndex} apexJoin=${c.apexJoin ? 'yes' : 'no'}`);
      }
    } catch (err) {
      errors[image] = err && err.message ? err.message : String(err);
    }
  }
  await cdp.close();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  if (chrome) await stopChrome(chrome);
  if (server) await new Promise(r => server.close(r));
  if (userDataDir) await removeWithRetry(userDataDir);
}

// ---- Evaluate ------------------------------------------------------------
let totalFailed = 0;
let totalChecked = 0;
let totalSkipped = 0;
let anyFixtureFailed = false;
for (const image of images) {
  if (errors[image]) {
    console.log(`\nERROR  ${image}   detection threw: ${errors[image]}`);
    anyFixtureFailed = true;
    continue;
  }
  const c = captures[image];
  if (!c) {
    console.log(`\nERROR  ${image}   no capture produced`);
    anyFixtureFailed = true;
    continue;
  }
  const fileKey = path.basename(image);
  const exp = (expectations && expectations[fileKey]) || {};
  const results = [];
  for (const assertion of ASSERTIONS) {
    if (assertion.require && !assertion.require(c, exp)) {
      results.push({ id: assertion.id, name: assertion.name, status: 'SKIP', msg: 'precondition false' });
      totalSkipped += 1;
      continue;
    }
    let res;
    try { res = assertion.test(c, exp); }
    catch (e) { res = { ok: false, msg: `threw: ${e && e.message ? e.message : e}` }; }
    results.push({ id: assertion.id, name: assertion.name, status: res.ok ? 'PASS' : 'FAIL', msg: res.msg });
    if (res.ok) totalChecked += 1;
    else { totalChecked += 1; totalFailed += 1; }
  }
  const fixtureFailed = results.some(r => r.status === 'FAIL');
  if (fixtureFailed) anyFixtureFailed = true;
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const skipCount = results.filter(r => r.status === 'SKIP').length;
  console.log(`\n${fixtureFailed ? 'FAIL' : 'PASS'}  ${image}   ${passCount} pass / ${failCount} fail / ${skipCount} skip`);
  for (const r of results) {
    if (r.status === 'FAIL') console.log(`   X  ${r.id}  ${r.name}  —  ${r.msg}`);
    else if (args.verbose && r.status === 'PASS') console.log(`   ✓  ${r.id}  ${r.name}  —  ${r.msg}`);
    else if (args.verbose && r.status === 'SKIP') console.log(`   ·  ${r.id}  ${r.name}  (${r.msg})`);
  }
}
console.log(`\nCONTRACT: ${anyFixtureFailed ? 'FAIL' : 'PASS'}   ${totalChecked - totalFailed}/${totalChecked} assertions ok, ${totalFailed} failed, ${totalSkipped} skipped`);
if (anyFixtureFailed) process.exitCode = 1;

// ---- In-page capture -----------------------------------------------------
function captureExpr(imagePath) {
  return `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const res = await fetch(${JSON.stringify(imagePath)} + '?contract=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch ' + res.status);
      const blob = await res.blob();
      const dataURL = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || '')); r.onerror = () => no(new Error('read')); r.readAsDataURL(blob); });
      const result = await debug.runAutoOnDataUrl(dataURL);
      const det = result.detection || {};
      const drafts = result.drafts || [];
      const poms = {};
      for (const d of drafts) {
        const pom = String(d.text != null ? d.text : d.seq);
        poms[pom] = {
          drawability: d.drawability || null,
          confidence: d.confidence || null,
          uncertainty: d.uncertainty || null,
          missingAnchors: Array.isArray(d.missingAnchors) ? d.missingAnchors : null,
          reviewNotes: Array.isArray(d.reviewNotes) ? d.reviewNotes : null,
          templateVersion: d.templateVersion || null,
          ruleVersion: d.ruleVersion || null,
        };
      }
      const anchors = {};
      for (const a of (result.anchors || [])) {
        anchors[a.kind] = {
          x: a.x, y: a.y,
          viewRole: a.viewRole || null,
          confidence: a.confidence || null,
          source: a.source || null,
          reviewRequired: !!a.reviewRequired,
          cupModelId: a.cupModelId || null,
          landmarkSourceClass: a.landmarkSourceClass || null,
          calibrated: !!a.calibrated,
        };
      }
      // Draft line geometry for every POM, mapped from board space back to
      // normalized image coords via the source image's rect — read by the
      // CLA.* line–anchor coherence assertions.
      const imgs = result.images || [];
      const srcImg = imgs.length ? imgs[imgs.length - 1] : null;
      const toNorm = (p) => (srcImg && srcImg.width > 0 && srcImg.height > 0 && p
        ? { x: (p.x - srcImg.x) / srcImg.width, y: (p.y - srcImg.y) / srcImg.height }
        : null);
      const pomGeom = {};
      for (const d of drafts) {
        const pom = String(d.text != null ? d.text : d.seq);
        pomGeom[pom] = {
          style: d.style || null,
          type: d.type || null,
          drawability: d.drawability || null,
          styleEvidenceStatus: d.styleEvidenceStatus || null,
          start: d.start ? toNorm(d.start) : null,
          end: d.end ? toNorm(d.end) : null,
        };
      }
      // Row-pair fallback branches. Every fixture in this corpus detects band
      // and chest ink on BOTH sides, so the corpus alone can never exercise the
      // one-sided seeding path — the exact path where the two ends of a row
      // used to receive different y values. Re-seed here from the same
      // detection with one side's ink fields removed, so the asymmetric branch
      // is covered without needing a sketch that happens to trigger it.
      const rowPairCases = [
        { key: 'band-right-missing',  pair: 'band',  nulls: ['bandRightX'] },
        { key: 'band-left-missing',   pair: 'band',  nulls: ['bandLeftX'] },
        { key: 'band-both-missing',   pair: 'band',  nulls: ['bandLeftX', 'bandRightX'] },
        { key: 'chest-right-missing', pair: 'chest', nulls: ['underbustRightX', 'chestRightX'] },
        { key: 'chest-left-missing',  pair: 'chest', nulls: ['underbustLeftX', 'chestLeftX'] },
        { key: 'chest-both-missing',  pair: 'chest',
          nulls: ['underbustLeftX', 'underbustRightX', 'chestLeftX', 'chestRightX'] },
      ];
      const rowPairs = {};
      const seedImage = imgs.length ? imgs[imgs.length - 1] : null;
      const pipe = debug.pipeline || {};
      if (seedImage && typeof pipe.seedAnchorsFromDetection === 'function') {
        for (const rc of rowPairCases) {
          try {
            const mutated = debug.getDetection();
            for (const field of rc.nulls) mutated[field] = null;
            // skipLearning: a polluted calibration store must not bias the
            // seeds under test (the residual buckets cover band anchors).
            const seeded = pipe.seedAnchorsFromDetection(mutated, seedImage, { skipLearning: true });
            const byKind = {};
            for (const anchor of seeded) byKind[anchor.kind] = anchor;
            const pom = rc.pair === 'band' ? '1' : '3';
            const fixture = pipe.buildPOMFixtureFromAnchors(seeded, mutated);
            const line = (fixture.annotations || []).find(r => String(r.pom) === pom) || null;
            const L = byKind[rc.pair + '-left'] || null;
            const R = byKind[rc.pair + '-right'] || null;
            rowPairs[rc.key] = {
              pair: rc.pair,
              pom,
              left: L ? { x: L.x, y: L.y } : null,
              right: R ? { x: R.x, y: R.y } : null,
              line: (line && line.start && line.end) ? { start: line.start, end: line.end } : null,
              // The row the pair SHOULD sit on, straight from the detection.
              detectedRow: rc.pair === 'band'
                ? (typeof mutated.bandY === 'number' ? mutated.bandY : null)
                : (typeof mutated.underbustY === 'number' ? mutated.underbustY
                  : (typeof mutated.chestY === 'number' ? mutated.chestY : null)),
            };
          } catch (e) {
            rowPairs[rc.key] = { pair: rc.pair, error: String((e && e.message) || e) };
          }
        }
      }

      return {
        anchors, poms, pomGeom, rowPairs,
        cupModel: det.cupModel ? {
          side: det.cupModel.side,
          viewRole: det.cupModel.viewRole,
          visibility: det.cupModel.visibility,
          innerEdgeSupported: det.cupModel.innerEdgeSupported !== false,
          id: det.cupModel.id || null,
        } : null,
        seamEvidence: det.seamEvidence || null,
        apexJoin: det.apexJoin || null,
        landmarkQa: det.landmarkQa
          ? { byKind: det.landmarkQa.byKind, summary: det.landmarkQa.summary }
          : null,
        axisX: typeof det.axisX === 'number' ? det.axisX : null,
        bandY: typeof det.bandY === 'number' ? det.bandY : null,
        chestY: typeof det.chestY === 'number' ? det.chestY : null,
        sideLeftX: typeof det.sideLeftX === 'number' ? det.sideLeftX : null,
        sideRightX: typeof det.sideRightX === 'number' ? det.sideRightX : null,
        frontInnerViewIndex: typeof det.frontInnerViewIndex === 'number' ? det.frontInnerViewIndex : null,
        backViewIndex: typeof det.backViewIndex === 'number' ? det.backViewIndex : null,
        viewCount: Array.isArray(det.views) ? det.views.length
          : (Array.isArray(det.viewBoxes) ? det.viewBoxes.length : null),
        axisConfidence: typeof det.axisConfidence === 'number' ? det.axisConfidence : null,
        baselineConfidence: typeof det.baselineConfidence === 'number' ? det.baselineConfidence : null,
      };
    })()
  `;
}

// ---- CDP plumbing (cloned from invariant-tests.mjs) ----------------------
function parseArgs(argv) {
  const p = {};
  for (const a of argv) {
    if (a === '--verbose') p.verbose = true;
    else if (a.startsWith('--chrome=')) p.chrome = a.slice(9);
    else if (a.startsWith('--only=')) p.only = a.slice(7);
    else fail(`Unknown argument: ${a}`);
  }
  return p;
}
function fail(m) { console.error(m); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}

async function waitForChromeTarget(port, targetUrl) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const t = targets.find(x => x.type === 'page' && x.url === targetUrl) || targets.find(x => x.type === 'page');
        if (t && t.webSocketDebuggerUrl) return t;
      }
    } catch (e) { lastError = e; }
    await sleep(150);
  }
  throw new Error(`Chrome DevTools target not ready.${lastError ? ` ${lastError.message}` : ''}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const m = JSON.parse(String(event.data));
    if (!m.id) return;
    const req = pending.get(m.id);
    if (!req) return;
    pending.delete(m.id);
    if (m.error) req.reject(new Error(m.error.message || JSON.stringify(m.error)));
    else req.resolve(m.result || {});
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { ws.close(); },
  };
}

async function waitForDebugApi(cdp) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const ok = await evaluate(cdp, 'typeof window.__braAutoModeDebug !== "undefined" && !!window.__braAutoModeDebug');
      if (ok) return;
    } catch (e) { /* context mid-navigation — retry */ }
    await sleep(150);
  }
  throw new Error('window.__braAutoModeDebug was not exposed within 15s');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error((d.exception && d.exception.description) ? d.exception.description : (d.text || 'evaluate failed'));
  }
  return result.result ? result.result.value : undefined;
}

async function stopChrome(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  proc.kill('SIGTERM');
  const exited = new Promise(r => proc.once('exit', r));
  const timedOut = sleep(2500).then(() => 'timeout');
  if (await Promise.race([exited, timedOut]) === 'timeout' && proc.exitCode === null) {
    proc.kill('SIGKILL');
    await Promise.race([exited, sleep(1000)]);
  }
}

async function removeWithRetry(p) {
  for (let i = 0; i < 5; i += 1) {
    try { await rm(p, { recursive: true, force: true }); return; }
    catch (e) { if (i === 4) { console.error(`Warning: could not remove ${p}: ${e.message}`); return; } await sleep(150 * (i + 1)); }
  }
}
