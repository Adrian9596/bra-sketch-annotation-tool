#!/usr/bin/env node
// Invariant-tests harness.
//
// Runs the auto-mode detector on every demo/*.jpg in headless Chrome and
// checks structural properties of the output that MUST hold if detection is
// correct (no labeled ground truth needed). This complements golden-tests
// (which only catches "did the output change") and accuracy-tests (which
// needs labeled fixtures we don't have yet).
//
//   node scripts/invariant-tests.mjs
//   node scripts/invariant-tests.mjs --only=demo3
//   node scripts/invariant-tests.mjs --verbose
//
// Priority 1 invariants (A1-A6 geometry, B1-B4 cup bounds, D1-D3 visibility →
// drawability). Adding more is just appending to the ASSERTIONS array.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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

const images = readdirSync(path.join(appDir, 'demo'))
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .filter(f => !args.only || f.includes(args.only))
  .sort()
  .map(f => `demo/${f}`);
if (!images.length) fail('No demo/*.jpg fixtures found.');

// ---- Invariant definitions ------------------------------------------------
// Each assertion: { id, name, require?, test }
//   require(c) -> bool: skip when false (e.g. POM is REVIEW_ONLY)
//   test(c)    -> { ok, msg }
const EPS_SAME_COL = 0.005;
const EPS_SAME_ROW = 0.005;
const EPS_CENTER_Y = 0.08;
// Max allowed height difference between the two POM 10 endpoints (invariant A3).
// They intentionally sit at their own heights now; this bounds the slant so the
// width line can never degenerate into a diagonal across the cup.
const EPS_ROW_SLANT = 0.09;
const EPS_AXIS_PAD = 0.005;
const EPS_SIDE_PAD = 0.003;
// The two ends of one horizontal-span pair (band, chest, back strap) read the
// SAME row variable in the seeder, so they must be exactly equal — this is a
// float-noise guard, not a tolerance (see the E-series).
const EPS_SHARED_ROW = 1e-9;
// Keep in lockstep with APEX_MAX_SLANT in src/auto/drafts/generate-pom-fixture.js
// and APEX_SLANT_LIMIT in src/auto-detection.js — E4 is the assertion that
// catches them drifting apart.
const APEX_SLANT_LIMIT = 0.06;

const has9 = (c) => c.poms && c.poms['9'] && c.poms['9'].drawability !== 'REVIEW_ONLY'
  && c.anchors['inner-cup-top'] && c.anchors['inner-cup-bottom'];
const has10 = (c) => c.poms && c.poms['10'] && c.poms['10'].drawability !== 'REVIEW_ONLY'
  && c.anchors['inner-cup-left'] && c.anchors['inner-cup-right'];
// B1/B2/B3/B4 validate the cup against the FRONT view's axis and cup side. When
// a front-inner view exists (a 3-view board / inner cutaway), POM 9/10 relocate
// onto that inner panel (US-049 / ADR-0034) and are no longer positioned by the
// front axis — so these front-axis checks do not apply. The inner-view shape is
// still guarded by the view-agnostic A-series (dimensions + endpoint ordering).
const cupOnInnerView = (c) => {
  const a = c.anchors['inner-cup-top'] || c.anchors['inner-cup-left'];
  return !!(a && a.viewRole === 'front_inner');
};

const ASSERTIONS = [
  // --- A: Geometric invariants ---------------------------------------------
  {
    id: 'A1', name: 'POM 9 is a height line (rise exceeds run)',
    require: has9,
    // POM 9 top sits on the cup apex and the bottom on the cup-center column,
    // so the line tilts slightly instead of being perfectly vertical. It must
    // still read as a HEIGHT measure: the vertical extent (rise) must exceed the
    // horizontal drift (run), otherwise the apex/bottom pairing is incoherent.
    test: (c) => {
      const dx = Math.abs(c.anchors['inner-cup-top'].x - c.anchors['inner-cup-bottom'].x);
      const dy = Math.abs(c.anchors['inner-cup-top'].y - c.anchors['inner-cup-bottom'].y);
      return { ok: dx < dy, msg: `run=${dx.toFixed(4)} rise=${dy.toFixed(4)} (need run < rise)` };
    },
  },
  {
    id: 'A2', name: 'POM 9 runs top-to-bottom',
    require: has9,
    test: (c) => {
      const top = c.anchors['inner-cup-top'].y;
      const bot = c.anchors['inner-cup-bottom'].y;
      return { ok: top < bot, msg: `top.y=${top.toFixed(4)} bot.y=${bot.toFixed(4)}` };
    },
  },
  {
    // Was "endpoints share row" (|Δy| < 0.005). POM 10 now spans the cup's true
    // horizontal extremes with EACH ENDPOINT AT ITS OWN HEIGHT — the gore contact
    // sits lower than the side-seam end, which is how a TD measures cup width — so
    // a strictly shared row is no longer the contract. What must still hold is that
    // the two endpoints read as ONE width measurement rather than a diagonal: the
    // slant stays bounded.
    id: 'A3', name: 'POM 10 endpoint slant bounded',
    require: has10,
    test: (c) => {
      const dy = Math.abs(c.anchors['inner-cup-left'].y - c.anchors['inner-cup-right'].y);
      return { ok: dy < EPS_ROW_SLANT, msg: `|Δy|=${dy.toFixed(4)} (need < ${EPS_ROW_SLANT})` };
    },
  },
  {
    id: 'A4', name: 'POM 10 runs left-to-right',
    require: has10,
    test: (c) => {
      const lx = c.anchors['inner-cup-left'].x;
      const rx = c.anchors['inner-cup-right'].x;
      return { ok: lx < rx, msg: `left.x=${lx.toFixed(4)} right.x=${rx.toFixed(4)}` };
    },
  },
  {
    id: 'A5', name: 'POM 9 bottom column lies between POM 10 endpoints',
    require: (c) => has9(c) && has10(c),
    // POM 9's top is now the cup apex (offset toward the strap, can sit outside
    // the width span). The BOTTOM sits on the cup-center column, which must
    // still fall between the POM 10 width endpoints — that anchors the height
    // line to the cup body the width was measured on.
    test: (c) => {
      const bx = c.anchors['inner-cup-bottom'].x;
      const lx = c.anchors['inner-cup-left'].x;
      const rx = c.anchors['inner-cup-right'].x;
      return { ok: lx <= bx && bx <= rx, msg: `${lx.toFixed(4)} ≤ ${bx.toFixed(4)} ≤ ${rx.toFixed(4)}` };
    },
  },
  {
    id: 'A6', name: 'POM 10 row near POM 9 mid-y',
    require: (c) => has9(c) && has10(c),
    // The endpoints no longer share a row (see A3), so "the row" is their MEAN
    // height — the level the width measurement represents. Using left.y alone
    // would arbitrarily judge the measurement by whichever end happens to sit
    // lower (the gore contact).
    test: (c) => {
      const mid = (c.anchors['inner-cup-top'].y + c.anchors['inner-cup-bottom'].y) / 2;
      const row = (c.anchors['inner-cup-left'].y + c.anchors['inner-cup-right'].y) / 2;
      const d = Math.abs(row - mid);
      return { ok: d < EPS_CENTER_Y, msg: `|row − mid|=${d.toFixed(4)} (need < ${EPS_CENTER_Y})` };
    },
  },

  // --- B: Cup-bounds invariants --------------------------------------------
  {
    id: 'B1', name: 'POM 9 sits on the picked cup side',
    require: (c) => has9(c) && !cupOnInnerView(c) && c.cupModel && c.cupModel.side != null && c.axisX != null,
    test: (c) => {
      const tx = c.anchors['inner-cup-top'].x;
      const side = c.cupModel.side;
      const ok = side < 0 ? tx < c.axisX : tx > c.axisX;
      return { ok, msg: `side=${side} axisX=${c.axisX.toFixed(4)} top.x=${tx.toFixed(4)}` };
    },
  },
  {
    id: 'B2', name: 'POM 10 stays inside the picked cup half',
    require: (c) => has10(c) && !cupOnInnerView(c) && c.cupModel && c.cupModel.side != null && c.axisX != null,
    test: (c) => {
      const lx = c.anchors['inner-cup-left'].x;
      const rx = c.anchors['inner-cup-right'].x;
      const side = c.cupModel.side;
      const inside = side < 0 ? (lx < c.axisX && rx < c.axisX) : (lx > c.axisX && rx > c.axisX);
      return { ok: inside, msg: `side=${side} axisX=${c.axisX.toFixed(4)} [${lx.toFixed(4)}, ${rx.toFixed(4)}]` };
    },
  },
  {
    id: 'B3', name: 'POM 10 endpoints clear of CF axis',
    require: (c) => has10(c) && !cupOnInnerView(c) && c.axisX != null,
    test: (c) => {
      const lx = c.anchors['inner-cup-left'].x;
      const rx = c.anchors['inner-cup-right'].x;
      const dL = Math.abs(lx - c.axisX);
      const dR = Math.abs(rx - c.axisX);
      const ok = dL > EPS_AXIS_PAD && dR > EPS_AXIS_PAD;
      return { ok, msg: `gap(L)=${dL.toFixed(4)} gap(R)=${dR.toFixed(4)} (need > ${EPS_AXIS_PAD})` };
    },
  },
  {
    id: 'B4', name: 'POM 10 outer endpoint clear of side seam',
    require: (c) => has10(c) && !cupOnInnerView(c) && c.cupModel && c.cupModel.side != null,
    test: (c) => {
      const side = c.cupModel.side;
      const sideCol = side < 0 ? c.sideLeftX : c.sideRightX;
      if (sideCol == null) return { ok: true, msg: 'side seam not detected — skipped' };
      // outer endpoint = the one closer to the side seam
      const lx = c.anchors['inner-cup-left'].x;
      const rx = c.anchors['inner-cup-right'].x;
      const outerX = side < 0 ? lx : rx;     // left cup → outer is leftmost endpoint
      const gap = Math.abs(outerX - sideCol);
      return { ok: gap > EPS_SIDE_PAD, msg: `sideCol=${sideCol.toFixed(4)} outer.x=${outerX.toFixed(4)} gap=${gap.toFixed(4)}` };
    },
  },

  // --- D: Visibility tier ↔ drawability mapping ----------------------------
  {
    id: 'D1', name: 'hidden cupModel → POM 9/10 are REVIEW_ONLY',
    require: (c) => c.cupModel && c.cupModel.visibility === 'hidden',
    test: (c) => {
      const p9 = c.poms && c.poms['9'];
      const p10 = c.poms && c.poms['10'];
      const ok = (!p9 || p9.drawability === 'REVIEW_ONLY')
              && (!p10 || p10.drawability === 'REVIEW_ONLY');
      return { ok, msg: `pom9=${p9 ? p9.drawability : '-'} pom10=${p10 ? p10.drawability : '-'}` };
    },
  },
  {
    id: 'D2', name: 'direct cupModel → POM 9/10 DRAWABLE with confidence',
    require: (c) => c.cupModel && c.cupModel.visibility === 'direct',
    test: (c) => {
      const p9 = c.poms && c.poms['9'];
      const p10 = c.poms && c.poms['10'];
      const okOne = (p) => p && p.drawability === 'DRAWABLE' && (p.confidence === 'medium' || p.confidence === 'high');
      const ok = okOne(p9) && okOne(p10);
      return { ok, msg: `pom9=${p9 ? `${p9.drawability}/${p9.confidence}` : '-'} pom10=${p10 ? `${p10.drawability}/${p10.confidence}` : '-'}` };
    },
  },
  {
    id: 'D3', name: 'inferred cupModel → POM 9/10 APPROXIMATE',
    require: (c) => c.cupModel && c.cupModel.visibility === 'inferred',
    test: (c) => {
      const p9 = c.poms && c.poms['9'];
      const p10 = c.poms && c.poms['10'];
      const okOne = (p) => p && p.drawability === 'APPROXIMATE';
      const ok = okOne(p9) && okOne(p10);
      return { ok, msg: `pom9=${p9 ? p9.drawability : '-'} pom10=${p10 ? p10.drawability : '-'}` };
    },
  },

  // --- E: shared-row model for the force-levelled horizontal spans ----------
  //
  // POM 1 (band), POM 3 (chest) and POM 15 (back strap) are horizontal spans:
  // the drafter draws them level at the LEFT end's y and discards the right
  // end's. That is correct TD semantics, but it silently misplaces the line
  // when the two anchors of the pair are seeded at different heights — the
  // line then misses the right anchor by exactly that gap while both pins
  // still render in the right place. These pairs are the two ends of ONE row
  // by definition, so the seeder must give them ONE y. Exact equality is the
  // contract (both ends read the same row variable), not an approximation.
  ...[
    ['E1', 'band',       '1',  'band-left',       'band-right'],
    ['E2', 'chest',      '3',  'chest-left',      'chest-right'],
    ['E3', 'back strap', '15', 'back-strap-left', 'back-strap-right'],
  ].map(([id, label, pom, leftKind, rightKind]) => ({
    id,
    name: `${leftKind} / ${rightKind} share one row (POM ${pom} draws level)`,
    require: (c) => !!(c.anchors[leftKind] && c.anchors[rightKind]),
    test: (c) => {
      const L = c.anchors[leftKind];
      const R = c.anchors[rightKind];
      const dy = Math.abs(L.y - R.y);
      return {
        ok: dy <= EPS_SHARED_ROW,
        msg: `${label} row: ${leftKind}.y=${L.y.toFixed(6)} ${rightKind}.y=${R.y.toFixed(6)} dy=${dy.toFixed(6)}`
          + ` (need <= ${EPS_SHARED_ROW}) — POM ${pom} would miss ${rightKind} by dy`,
      };
    },
  })),

  // --- E4: POM 16's drawability tracks the apex pair's credibility ----------
  // Two halves have to agree here, and E4 is what keeps them agreeing:
  //   - the DETECTOR (US-084) repairs a pair that straddles two rows by
  //     re-searching the outlier side around the trusted side's row, and leaves
  //     the pair alone when it cannot reconcile it;
  //   - the DRAFTER (US-083) draws POM 16 level at the pair's midpoint, and
  //     demotes to REVIEW_ONLY when the pair slants past the same limit.
  // So a drawn POM 16 implies a reconciled pair and vice versa. If the two
  // limits ever drift apart, this fails instead of silently drawing a line off
  // a mis-detected apex (or withholding one from a good pair).
  {
    id: 'E4',
    name: 'POM 16 is drawable exactly when the apex pair slant is within limit',
    require: (c) => !!(c.anchors['apex-left'] && c.anchors['apex-right']
      && c.poms && c.poms['16']),
    test: (c) => {
      const L = c.anchors['apex-left'];
      const R = c.anchors['apex-right'];
      const dx = Math.abs(R.x - L.x);
      const slant = dx > 0 ? Math.abs(L.y - R.y) / dx : Infinity;
      const drawable = c.poms['16'].drawability !== 'REVIEW_ONLY';
      const within = slant <= APEX_SLANT_LIMIT;
      return {
        ok: drawable === within,
        msg: `slant=${Number.isFinite(slant) ? slant.toFixed(4) : 'inf'}`
          + ` (limit ${APEX_SLANT_LIMIT}) drawability=${c.poms['16'].drawability}`
          + (drawable === within ? '' : ' — drawability and slant disagree'),
      };
    },
  },
];

// ---- Run all fixtures -----------------------------------------------------
let server, chrome, userDataDir;
const captures = {};
const errors = {};

try {
  const { server: httpServer, baseUrl } = await startStaticServer(appDir);
  server = httpServer;
  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-invariants-'));
  const targetUrl = `${baseUrl}/index.html?invariants=${Date.now()}&freeCv=1`;

  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    // Force the offline ink-mask path via ?freeCv=1 in the target URL (same
    // as golden-tests) so output is deterministic and network-free; the
    // resolver rule below is legacy belt-and-braces (opencv.js is vendored).
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
        const vis = captures[image].cupModel ? captures[image].cupModel.visibility : '-';
        console.error(`[${image}] captured. visibility=${vis} anchors=${Object.keys(captures[image].anchors).length}`);
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

// ---- Evaluate assertions --------------------------------------------------
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
  const results = [];
  for (const a of ASSERTIONS) {
    if (a.require && !a.require(c)) {
      results.push({ id: a.id, name: a.name, status: 'SKIP', msg: 'precondition false' });
      totalSkipped += 1;
      continue;
    }
    let res;
    try { res = a.test(c); }
    catch (e) { res = { ok: false, msg: `threw: ${e && e.message ? e.message : e}` }; }
    results.push({ id: a.id, name: a.name, status: res.ok ? 'PASS' : 'FAIL', msg: res.msg });
    if (res.ok) totalChecked += 1;
    else { totalChecked += 1; totalFailed += 1; }
  }
  const fixtureFailed = results.some(r => r.status === 'FAIL');
  if (fixtureFailed) anyFixtureFailed = true;
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const skipCount = results.filter(r => r.status === 'SKIP').length;
  const vis = c.cupModel ? c.cupModel.visibility : '-';
  const side = c.cupModel && c.cupModel.side != null ? (c.cupModel.side < 0 ? 'L' : 'R') : '-';
  console.log(`\n${fixtureFailed ? 'FAIL' : 'PASS'}  ${image}   visibility=${vis} side=${side}   ${passCount} pass / ${failCount} fail / ${skipCount} skip`);
  for (const r of results) {
    if (r.status === 'FAIL') console.log(`   X  ${r.id}  ${r.name}  —  ${r.msg}`);
    else if (args.verbose && r.status === 'PASS') console.log(`   ✓  ${r.id}  ${r.name}  —  ${r.msg}`);
    else if (args.verbose && r.status === 'SKIP') console.log(`   ·  ${r.id}  ${r.name}  (skipped: ${r.msg})`);
  }
}

console.log(`\nINVARIANTS: ${anyFixtureFailed ? 'FAIL' : 'PASS'}   ${totalChecked - totalFailed}/${totalChecked} assertions ok, ${totalFailed} failed, ${totalSkipped} skipped`);
if (anyFixtureFailed) process.exitCode = 1;

// ---- In-page capture ------------------------------------------------------
function captureExpr(imagePath) {
  return `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const res = await fetch(${JSON.stringify(imagePath)} + '?invariants=' + Date.now(), { cache: 'no-store' });
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
        };
      }
      const anchors = {};
      for (const a of (result.anchors || [])) {
        anchors[a.kind] = { x: a.x, y: a.y, viewRole: a.viewRole || null };
      }
      const cupModel = det.cupModel ? {
        side: det.cupModel.side,
        viewRole: det.cupModel.viewRole,
        visibility: det.cupModel.visibility,
        topFromApex: det.cupModel.topFromApex,
        bottomFromSeam: det.cupModel.bottomFromSeam,
      } : null;
      return {
        anchors, poms, cupModel,
        axisX: typeof det.axisX === 'number' ? det.axisX : null,
        chestY: typeof det.chestY === 'number' ? det.chestY : null,
        underbustY: typeof det.underbustY === 'number' ? det.underbustY : null,
        cradleY: typeof det.cradleY === 'number' ? det.cradleY : null,
        bandY: typeof det.bandY === 'number' ? det.bandY : null,
        sideLeftX: typeof det.sideLeftX === 'number' ? det.sideLeftX : null,
        sideRightX: typeof det.sideRightX === 'number' ? det.sideRightX : null,
        draftCount: drafts.length,
      };
    })()
  `;
}

// ---- CDP plumbing (mirrors golden-tests.mjs) ------------------------------
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
