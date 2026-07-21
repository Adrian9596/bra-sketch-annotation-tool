#!/usr/bin/env node
// scripts/demo-detection.mjs
// -----------------------------------------------------------------------------
// READ-ONLY observation tooling. Runs the REAL Auto-Mode detection pipeline on
// every demo/*.{jpg,jpeg,png,webp} in headless Chrome and prints a plain-text
// terminal report of what the detector drafted:
//
//   * Per image: each drafted POM (all 16 where drafted) with confidence tier
//     + drawability, the cup-model visibility, and which anchors are flagged
//     reviewRequired.
//   * A final "gap summary" rollup: for each POM, how many images are
//     low-confidence or review-flagged across the corpus, so a reader instantly
//     sees where the detector is weak.
//
// This script does NOT edit app.js / src / detection logic. It only observes.
//
//   node scripts/demo-detection.mjs
//   node scripts/demo-detection.mjs --only=demo3
//   node scripts/demo-detection.mjs --chrome=/path/to/Chrome
//
// -----------------------------------------------------------------------------
// !!! THE #1 GOTCHA — the `?contract=` query param !!!
// -----------------------------------------------------------------------------
// We MUST navigate to index.html with a RECOGNIZED test query param (here
// `?contract=<timestamp>`; `?smoke=` / `?golden=` also work). Without one,
// maybePromptForViewRoles (src/auto-detection.js ~line 169) pops a BLOCKING
// view-role modal that never resolves in headless Chrome, so
// runAutoOnDataUrl hangs FOREVER. The param is baked into targetUrl below.
// Do not remove it.
// -----------------------------------------------------------------------------
//
// The Chrome + CDP plumbing (waitForChromeTarget / connectCdp / evaluate /
// waitForDebugApi / stopChrome, plus startStaticServer / getFreePort) is copied
// verbatim from scripts/pom-contract-tests.mjs — those helpers are not exported.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
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

// Human-readable names for the 16 standard bra POM lines (report labels only).
const POM_NAMES = {
  1: '1/2 bottom band',
  2: 'bottom band extension',
  3: '1/2 chest',
  4: 'chest extension',
  5: 'CF height (full)',
  6: 'cradle height at CF',
  7: 'cradle height at bottom cup',
  8: 'cup height at CF',
  9: 'inner cup height',
  10: 'inner cup width',
  11: 'side height',
  12: 'back height',
  13: 'back panel height',
  14: 'strap length',
  15: 'back strap distance',
  16: 'front apex distance',
};
const ALL_POMS = Object.keys(POM_NAMES).map(Number).sort((a, b) => a - b);

const images = readdirSync(path.join(appDir, 'demo'))
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .filter(f => !args.only || f.includes(args.only))
  .sort()
  .map(f => `demo/${f}`);
if (!images.length) fail('No demo/*.{jpg,jpeg,png,webp} images found.');

// ---- Run -----------------------------------------------------------------
let chrome; let server; let userDataDir;
const captures = {};
const errors = {};

try {
  const { server: httpServer, baseUrl } = await startStaticServer(appDir);
  server = httpServer;
  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-demo-'));
  // See the big banner above — the ?contract= param is REQUIRED to avoid the
  // blocking view-role modal that would hang runAutoOnDataUrl forever.
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

  process.stderr.write(`Running detector on ${images.length} image(s)...\n`);
  for (const image of images) {
    try {
      // Fresh navigation per image so each run starts from a clean page state.
      await cdp.send('Page.navigate', { url: targetUrl });
      await waitForDebugApi(cdp);
      // 90s per image: the FIRST image cold-compiles OpenCV/wasm and is slow.
      captures[image] = await withTimeout(evaluate(cdp, captureExpr(image)), 90000, image);
      process.stderr.write(`  ok      ${image}\n`);
    } catch (err) {
      // One bad image must not abort the whole corpus run.
      errors[image] = err && err.message ? err.message : String(err);
      process.stderr.write(`  FAILED  ${image}  — ${errors[image]}\n`);
    }
  }
  await cdp.close();

  // --dump-anchors=<dir>: write each image's detected anchors (normalized x/y +
  // viewRole + confidence + reviewRequired) as a fixture the offline lab bridge
  // consumes (US-039 Stage 1). Read-only w.r.t. detection; just persists output.
  if (args.dumpAnchors) {
    const outDir = path.isAbsolute(args.dumpAnchors) ? args.dumpAnchors : path.join(appDir, args.dumpAnchors);
    mkdirSync(outDir, { recursive: true });
    let written = 0;
    for (const [image, cap] of Object.entries(captures)) {
      if (!cap || !cap.anchors) continue;
      const base = path.basename(image);
      writeFileSync(path.join(outDir, base + '.json'), JSON.stringify({
        image: base,
        source: 'production_detected',
        ruleNote: 'Real anchors from the production detector (npm run demo -- --dump-anchors). Normalized [0,1] in source-image pixel space.',
        cupModel: cap.cupModel || null,
        anchors: cap.anchors,
      }, null, 2) + '\n');
      written += 1;
    }
    process.stderr.write(`\nDumped ${written} anchor fixture(s) to ${path.relative(appDir, outDir)}/\n`);
  }
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  // Always clean up: kill Chrome, close the server, remove the temp profile.
  if (chrome) await stopChrome(chrome);
  if (server) await new Promise(r => server.close(r));
  if (userDataDir) await removeWithRetry(userDataDir);
}

// ---- Report --------------------------------------------------------------
printReport();

function printReport() {
  const line = '='.repeat(78);
  console.log(`\n${line}`);
  console.log('AUTO-MODE DETECTION DEMO REPORT');
  console.log(`${images.length} image(s) from demo/  —  ${new Date().toISOString()}`);
  console.log(line);

  // Corpus-wide tally used for the gap summary: per POM, how many images had it
  // drafted, drafted low-confidence, or review-only, plus review-flagged anchors.
  const pomStats = {};
  for (const p of ALL_POMS) pomStats[p] = { drafted: 0, low: 0, reviewOnly: 0, approx: 0, anchorReview: 0 };
  let okImages = 0;

  for (const image of images) {
    const name = path.basename(image);
    console.log(`\n${'-'.repeat(78)}`);
    console.log(`IMAGE  ${name}`);
    console.log('-'.repeat(78));

    if (errors[image]) {
      console.log(`  ERROR: detection failed — ${errors[image]}`);
      continue;
    }
    const c = captures[image];
    if (!c) {
      console.log('  ERROR: no capture produced');
      continue;
    }
    okImages += 1;

    // --- Cup model line ---
    const cm = c.cupModel;
    if (cm) {
      console.log(`  Cup model: visibility=${cm.visibility || '-'}  side=${sideLabel(cm.side)}  view=${cm.viewRole || '-'}`);
      console.log(`             topFromApex=${fmtBool(cm.topFromApex)}  bottomFromSeam=${fmtBool(cm.bottomFromSeam)}`
        + `  contourConf=${fmtNum(cm.contourConfidence)}  seamConf=${fmtNum(cm.seamConfidence)}`);
    } else {
      console.log('  Cup model: (none built)');
    }
    console.log(`  frontInnerViewIndex=${c.frontInnerViewIndex == null ? '-' : c.frontInnerViewIndex}`
      + `${c.frontInnerViewIndex === -1 ? ' (no separate front-inner view)' : ''}`);

    // --- POM table ---
    console.log('');
    console.log(`  ${pad('POM', 5)}${pad('Name', 30)}${pad('Confidence', 12)}${pad('Drawability', 14)}`);
    console.log(`  ${'-'.repeat(5)}${'-'.repeat(30)}${'-'.repeat(12)}${'-'.repeat(14)}`);
    let draftedCount = 0;
    for (const p of ALL_POMS) {
      const d = c.poms[String(p)];
      const nm = POM_NAMES[p];
      if (!d) {
        console.log(`  ${pad(String(p), 5)}${pad(nm, 30)}${pad('—', 12)}${pad('(not drafted)', 14)}`);
        continue;
      }
      draftedCount += 1;
      pomStats[p].drafted += 1;
      const conf = d.confidence || '-';
      const draw = d.drawability || '-';
      if (conf === 'low') pomStats[p].low += 1;
      if (draw === 'REVIEW_ONLY') pomStats[p].reviewOnly += 1;
      if (draw === 'APPROXIMATE') pomStats[p].approx += 1;
      const flag = (conf === 'low' || draw === 'REVIEW_ONLY') ? '  <-- weak' : '';
      console.log(`  ${pad(String(p), 5)}${pad(nm, 30)}${pad(conf, 12)}${pad(draw, 14)}${flag}`);
    }
    console.log(`  (${draftedCount}/18 POMs drafted)`);

    // --- Review-flagged anchors ---
    const flagged = Object.entries(c.anchors)
      .filter(([, v]) => v.reviewRequired)
      .map(([k, v]) => `${k}${v.confidence ? `(${v.confidence})` : ''}`);
    // Roll each flagged anchor up to the POM(s) it feeds for the gap summary.
    for (const [kind] of Object.entries(c.anchors).filter(([, v]) => v.reviewRequired)) {
      for (const p of pomsForAnchor(kind)) pomStats[p].anchorReview += 1;
    }
    console.log('');
    if (flagged.length) {
      console.log(`  reviewRequired anchors (${flagged.length}): ${flagged.join(', ')}`);
    } else {
      console.log('  reviewRequired anchors: none');
    }
  }

  // --- Gap summary rollup ---
  const line2 = '='.repeat(78);
  console.log(`\n${line2}`);
  console.log(`GAP SUMMARY  (where the detector is weak across ${okImages}/${images.length} captured image(s))`);
  console.log(line2);
  console.log(`  ${pad('POM', 5)}${pad('Name', 30)}${pad('Drafted', 9)}${pad('Low', 6)}${pad('Approx', 8)}${pad('RevOnly', 9)}${pad('AnchorRev', 10)}`);
  console.log(`  ${'-'.repeat(5)}${'-'.repeat(30)}${'-'.repeat(9)}${'-'.repeat(6)}${'-'.repeat(8)}${'-'.repeat(9)}${'-'.repeat(10)}`);
  const weakSpots = [];
  for (const p of ALL_POMS) {
    const s = pomStats[p];
    const weak = s.low + s.reviewOnly;
    if (weak > 0 || s.approx > 0 || s.anchorReview > 0) {
      weakSpots.push({ p, ...s, weak });
    }
    const flag = weak > 0 ? '  <-- weak' : '';
    console.log(`  ${pad(String(p), 5)}${pad(POM_NAMES[p], 30)}${pad(`${s.drafted}/${okImages}`, 9)}`
      + `${pad(String(s.low), 6)}${pad(String(s.approx), 8)}${pad(String(s.reviewOnly), 9)}${pad(String(s.anchorReview), 10)}${flag}`);
  }

  console.log('');
  if (weakSpots.length) {
    // Sort weakest-first: most low+review-only images at top.
    weakSpots.sort((a, b) => (b.weak - a.weak) || (b.anchorReview - a.anchorReview) || (a.p - b.p));
    console.log('  Weakest POMs (low-confidence or review-only most often):');
    for (const w of weakSpots.slice(0, 8)) {
      const parts = [];
      if (w.low) parts.push(`${w.low} low`);
      if (w.reviewOnly) parts.push(`${w.reviewOnly} review-only`);
      if (w.approx) parts.push(`${w.approx} approximate`);
      if (w.anchorReview) parts.push(`${w.anchorReview} review-flagged anchor(s)`);
      console.log(`    POM ${pad(String(w.p), 3)} ${pad(POM_NAMES[w.p], 30)} ${parts.join(', ')}`);
    }
  } else {
    console.log('  No low-confidence, approximate, or review-flagged POMs across the corpus.');
  }

  const failed = images.filter(i => errors[i]).map(i => path.basename(i));
  console.log(`\n  Captured ${okImages}/${images.length} images without error.`);
  if (failed.length) {
    console.log(`  FAILED images: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
  console.log('');
}

// Map an anchor kind to the POM line(s) it feeds, so a review-flagged anchor is
// credited to the right POM(s) in the gap summary. Mirrors the anchor→line
// construction in the app; unknown kinds map to nothing (ignored).
function pomsForAnchor(kind) {
  const map = {
    'band-left': [1, 2], 'band-right': [1, 2],
    'chest-left': [3, 4], 'chest-right': [3, 4],
    'cf-top': [5, 8], 'cf-bottom': [5, 6],
    'cradle-cf-top': [6, 8],
    'cradle-cup-top': [7], 'cradle-cup-bottom': [7],
    'inner-cup-top': [9], 'inner-cup-bottom': [9],
    'inner-cup-left': [10], 'inner-cup-right': [10],
    'side-top': [11], 'side-bottom': [11],
    'back-top': [12, 13], 'back-bottom': [12, 13],
    'back-panel-top': [13], 'back-panel-bottom': [13],
    'strap-top': [14], 'strap-bottom': [14],
    'back-strap-left': [15], 'back-strap-right': [15],
    'apex-left': [16], 'apex-right': [16],
  };
  return map[kind] || [];
}

// ---- Formatting helpers ---------------------------------------------------
function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w - 1) + ' ' : s + ' '.repeat(w - s.length); }
function fmtNum(n) { return typeof n === 'number' ? n.toFixed(2) : '-'; }
function fmtBool(b) { return b === true ? 'yes' : b === false ? 'no' : '-'; }
function sideLabel(s) { return s === 1 ? 'R' : s === -1 ? 'L' : (s == null ? '-' : String(s)); }

// ---- In-page capture -----------------------------------------------------
// Runs entirely inside the page. Fetches the demo image, converts it to a
// dataURL, runs the full pipeline via runAutoOnDataUrl, and returns a compact,
// serializable snapshot (drafts + anchors + cupModel + view index).
function captureExpr(imagePath) {
  return `
    (async () => {
      const debug = window.__braAutoModeDebug;
      // Cache-bust so re-runs never read a stale image blob.
      const res = await fetch(${JSON.stringify(imagePath)} + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch ' + res.status);
      const blob = await res.blob();
      const dataURL = await new Promise((ok, no) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result || ''));
        r.onerror = () => no(new Error('FileReader failed'));
        r.readAsDataURL(blob);
      });
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
      for (const an of (result.anchors || [])) {
        anchors[an.kind] = {
          x: typeof an.x === 'number' ? Math.round(an.x * 1e6) / 1e6 : null,
          y: typeof an.y === 'number' ? Math.round(an.y * 1e6) / 1e6 : null,
          viewRole: an.viewRole || null,
          confidence: an.confidence || null,
          source: an.source || null,
          reviewRequired: !!an.reviewRequired,
        };
      }
      return {
        anchors, poms,
        cupModel: det.cupModel ? {
          side: det.cupModel.side,
          viewRole: det.cupModel.viewRole,
          visibility: det.cupModel.visibility,
          topFromApex: det.cupModel.topFromApex,
          bottomFromSeam: det.cupModel.bottomFromSeam,
          contourConfidence: typeof det.cupModel.contourConfidence === 'number' ? det.cupModel.contourConfidence : null,
          seamConfidence: typeof det.cupModel.seamConfidence === 'number' ? det.cupModel.seamConfidence : null,
        } : null,
        frontInnerViewIndex: typeof det.frontInnerViewIndex === 'number' ? det.frontInnerViewIndex : null,
      };
    })()
  `;
}

// ---- CDP plumbing (copied from scripts/pom-contract-tests.mjs) ------------
function parseArgs(argv) {
  const p = {};
  for (const a of argv) {
    if (a.startsWith('--chrome=')) p.chrome = a.slice(9);
    else if (a.startsWith('--only=')) p.only = a.slice(7);
    else if (a.startsWith('--dump-anchors=')) p.dumpAnchors = a.slice(15);
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
