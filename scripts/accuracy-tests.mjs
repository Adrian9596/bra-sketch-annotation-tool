#!/usr/bin/env node
// Accuracy harness — scores detector output against HUMAN-PLACED ground truth.
//
// This is the only test that answers "is Auto Mode CORRECT", as opposed to
// golden-tests.mjs which answers "is Auto Mode STABLE" (drift vs. a self-seeded
// baseline). Here the baseline is a TD's corrected anchor positions, so a lower
// score is always better and tuning changes can be judged honestly.
//
// Ground truth lives in scripts/groundtruth/<image-basename>.json and is
// produced by the in-app labeling flow: open index.html?label=1, add the
// image, Detect Sketch, drag every anchor onto the real landmark, then click
// "Save Ground Truth" and drop the file in that folder. See its README.
//
//   node scripts/accuracy-tests.mjs              # score every labeled demo image
//   node scripts/accuracy-tests.mjs --only=demo1 # one image
//   node scripts/accuracy-tests.mjs --verbose    # also dump detected anchors
//   node scripts/accuracy-tests.mjs --update     # re-seed the regression baseline
//   ACCURACY_TOL=0.03 node scripts/accuracy-tests.mjs
//
// REGRESSION GATE: scores are additionally compared against the committed
// baseline in scripts/groundtruth/accuracy-baseline.json. A run whose
// per-image mean/max, per-kind mean, missing-anchor count, or overall mean is
// WORSE than baseline (beyond a small epsilon) exits non-zero — so a detection
// change that hurts correctness fails loudly instead of only printing numbers.
// Improvements never fail; lock them in with --update so the baseline ratchets
// toward zero. Gate epsilons: ACCURACY_GATE_MEAN_EPS (default 0.001),
// ACCURACY_GATE_MAX_EPS (0.005), ACCURACY_GATE_KIND_EPS (0.005).
// The gate only runs on a full run (no --only) so partial runs can't reseed
// or misjudge whole-corpus numbers.
//
// Reuses the dependency-free Chrome + raw-CDP plumbing from golden-tests.mjs,
// and pins detection to the deterministic OFFLINE ink-mask path (same as
// golden) so numbers are reproducible. NOTE: the shipped app prefers the real
// opencv.js WASM backend; this harness measures the offline detector.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const gtDir = path.join(scriptDir, 'groundtruth');

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Two acceptance bands, in normalized image units (fraction of width/height):
//   TIGHT  ~ "a TD would not bother touching this anchor"
//   LOOSE  ~ "close enough that a small nudge fixes it"
// Calibrate these against real TD-drag residuals once a corpus exists.
const TOL_TIGHT = Number(process.env.ACCURACY_TOL || 0.02);
const TOL_LOOSE = Number(process.env.ACCURACY_TOL_LOOSE || 0.04);

// Regression-gate slack, in the same normalized units. The detector is
// deterministic on the pinned offline path, so these only need to absorb
// float noise plus genuinely negligible drift — anything larger is a real
// correctness regression and should fail.
const BASELINE_PATH = path.join(gtDir, 'accuracy-baseline.json');
const GATE_MEAN_EPS = Number(process.env.ACCURACY_GATE_MEAN_EPS || 0.001);
const GATE_MAX_EPS = Number(process.env.ACCURACY_GATE_MAX_EPS || 0.005);
const GATE_KIND_EPS = Number(process.env.ACCURACY_GATE_KIND_EPS || 0.005);

// Hash of the app.js this run is supposed to measure. captureOnce() verifies
// the served copy against this before every detection (stale-Drive-read guard).
const APP_JS_SHA256 = createHash('sha256').update(readFileSync(path.join(appDir, 'app.js'))).digest('hex');
const SERVED_APP_HASH_EXPR = `
  (async () => {
    const res = await fetch('app.js', { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch app.js ' + res.status);
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  })()
`;

const args = parseArgs(process.argv.slice(2));
const chromePath = args.chrome || process.env.CHROME_PATH || DEFAULT_CHROME;
if (!existsSync(chromePath)) fail(`Chrome not found at ${chromePath}. Pass --chrome=/path or set CHROME_PATH.`);

// Images to score: every top-level demo fixture, PLUS any image a ground-truth
// file points at through `imagePath`. The directory scan is deliberately not
// recursive, so boards that live in a subfolder (e.g. "demo/2 photo case/")
// were previously invisible to this suite no matter how well they were
// labelled — the ground truth simply never ran. Letting a GT file name its own
// image is what makes those boards scorable (backlog #11).
const demoImages = readdirSync(path.join(appDir, 'demo'))
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .map(f => `demo/${f}`);
const gtDeclaredImages = readdirSync(gtDir)
  .filter(f => f.endsWith('.json'))
  .map(f => {
    try { return JSON.parse(readFileSync(path.join(gtDir, f), 'utf8')).imagePath; }
    catch (_) { return null; }
  })
  .filter(p => typeof p === 'string' && p);
const images = [...new Set([...demoImages, ...gtDeclaredImages])]
  .filter(f => existsSync(path.join(appDir, f)))
  .filter(f => !args.only || f.includes(args.only))
  .sort();
if (!images.length) fail('No demo/*.jpg fixtures found.');

// A ground-truth file may declare a MULTI-PHOTO board. The board a TD actually
// assembles is often two photos — the primary carrying front-outer + back, an
// aux carrying the front-inner cutaway — and detection only reproduces it when
// both are loaded. Scoring the primary alone measured a board the TD never has,
// and let the aux-view path regress with every suite green; that blind spot is
// exactly why debug-api's runAutoOnDataUrl grew an auxDataURLs option. Returns
// [] for the ordinary single-image fixture, so those are unchanged.
function boardAuxFor(image) {
  const gtFile = gtPathFor(image);
  if (!existsSync(gtFile)) return [];
  try {
    const board = JSON.parse(readFileSync(gtFile, 'utf8')).board;
    const aux = board && board.aux;
    return Array.isArray(aux) ? aux.filter(p => typeof p === 'string' && existsSync(path.join(appDir, p))) : [];
  } catch (_) { return []; }
}

let server, chrome, userDataDir;
const captures = {};
const errors = {};

try {
  const { server: httpServer, baseUrl } = await startStaticServer(appDir);
  server = httpServer;
  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-accuracy-'));
  const targetUrl = `${baseUrl}/index.html?accuracy=${Date.now()}&freeCv=1`;

  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    // Force the deterministic offline ink-mask path via ?freeCv=1 in the
    // target URL. Mirrors golden-tests.mjs for reproducible numbers; the
    // resolver rule below is legacy belt-and-braces (opencv.js is vendored).
    '--host-resolver-rules=MAP docs.opencv.org 127.0.0.1:9',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, targetUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', c => { chromeStderr += String(c); });

  const target = await waitForChromeTarget(cdpPort, targetUrl);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // Disable Chrome's cache entirely: on this Google Drive checkout the FIRST
  // read of app.js after file churn can be served stale, and a cached stale
  // app.js would then poison every navigation in this process (observed as
  // the fragile cradle anchors silently missing on demo4/5/7). With the cache
  // off, each captureOnce() re-navigation re-fetches app.js, and the served
  // hash is verified against disk before detection runs.
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  for (const image of images) {
    try {
      captures[image] = await captureOnce(cdp, targetUrl, image);
      // Retry once when a ground-truth anchor kind went unseeded. On this
      // Google Drive checkout the FIRST detection after file churn can see
      // inconsistent reads and silently drop the most fragile anchors
      // (cradle junction/crest tiers); a real regression is deterministic
      // and fails both passes, so the retry can't mask one.
      const gtFile = gtPathFor(image);
      if (existsSync(gtFile)) {
        const gtKinds = Object.keys(JSON.parse(readFileSync(gtFile, 'utf8')).anchors || {});
        const unseeded = gtKinds.filter(k => !captures[image].anchors[k]);
        if (unseeded.length) {
          console.error(`  (retrying ${image}: ${unseeded.length} ground-truth anchor(s) unseeded on first pass — cold-read flake check)`);
          captures[image] = await captureOnce(cdp, targetUrl, image);
        }
      }
    } catch (err) {
      errors[image] = err && err.message ? err.message : String(err);
    }
  }
  await cdp.close();
  if (chromeStderr && args.verbose) console.error(chromeStderr.trim());
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  if (chrome) await stopChrome(chrome);
  if (server) await new Promise(r => server.close(r));
  if (userDataDir) await removeWithRetry(userDataDir);
}

// ---- scoring --------------------------------------------------------------
function gtPathFor(image) { return path.join(gtDir, path.basename(image) + '.json'); }

async function captureOnce(cdp, targetUrl, image) {
  // Navigate until the page is running the app.js that is actually on disk.
  // A mismatch means the static server got a stale Drive read — settle and
  // re-navigate rather than scoring a detector from another era.
  for (let attempt = 1; ; attempt += 1) {
    await cdp.send('Page.navigate', { url: targetUrl });
    await waitForDebugApi(cdp);
    const served = await withTimeout(evaluate(cdp, SERVED_APP_HASH_EXPR), 15000, `${image} app.js hash`);
    if (served === APP_JS_SHA256) break;
    if (attempt >= 5) throw new Error(`served app.js hash ${String(served).slice(0, 12)}… still != disk ${APP_JS_SHA256.slice(0, 12)}… after ${attempt} attempts (stale Drive reads?)`);
    console.error(`  (re-navigating for ${image}: served app.js is stale — attempt ${attempt})`);
    await sleep(400 * attempt);
  }
  return withTimeout(evaluate(cdp, captureExpr(image, boardAuxFor(image))), 30000, image);
}

const perImage = [];
const perKind = new Map();   // kind -> [errors]
const unlabeled = [];
const threw = [];

for (const image of images) {
  if (errors[image]) { threw.push({ image, msg: errors[image] }); continue; }
  const cur = captures[image];
  if (!cur) { threw.push({ image, msg: 'no capture produced' }); continue; }

  const gtFile = gtPathFor(image);
  if (!existsSync(gtFile)) {
    unlabeled.push({ image, anchorCount: Object.keys(cur.anchors).length });
    continue;
  }
  const gt = JSON.parse(readFileSync(gtFile, 'utf8'));
  const gtAnchors = gt.anchors || {};
  const report = { image, errs: [], missing: [], extra: [], maxErr: 0 };

  const gtKinds = Object.keys(gtAnchors);
  for (const kind of gtKinds) {
    const truth = gtAnchors[kind];
    const got = cur.anchors[kind];
    if (!got) { report.missing.push(kind); continue; }
    const err = Math.hypot(got.x - truth.x, got.y - truth.y);
    report.errs.push({ kind, err });
    report.maxErr = Math.max(report.maxErr, err);
    if (!perKind.has(kind)) perKind.set(kind, []);
    perKind.get(kind).push(err);
  }
  for (const kind of Object.keys(cur.anchors)) {
    if (!gtAnchors[kind]) report.extra.push(kind);
  }
  report.errs.sort((a, b) => b.err - a.err);
  perImage.push(report);
}

printReport();
runBaselineGate();

// ---- regression gate --------------------------------------------------------
// Compares this run against scripts/groundtruth/accuracy-baseline.json and
// fails the process when correctness got WORSE. Improvements pass (with a hint
// to ratchet the baseline via --update).
function summarizeRun() {
  const perImageSummary = {};
  const allErrs = [];
  for (const r of perImage) {
    const errVals = r.errs.map(e => e.err);
    allErrs.push(...errVals);
    perImageSummary[r.image] = {
      mean: round6(mean(errVals)),
      p90: round6(p90(errVals)),
      max: round6(r.maxErr),
      scored: errVals.length,
      missing: r.missing.length,
    };
  }
  const perKindSummary = {};
  for (const [kind, errs] of [...perKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    perKindSummary[kind] = { mean: round6(mean(errs)), n: errs.length };
  }
  return {
    tolTight: TOL_TIGHT,
    tolLoose: TOL_LOOSE,
    overall: {
      mean: round6(mean(allErrs)),
      p90: round6(p90(allErrs)),
      scored: allErrs.length,
      images: perImage.length,
    },
    perImage: perImageSummary,
    perKind: perKindSummary,
  };
}

function runBaselineGate() {
  if (process.exitCode) return;                 // detection already failed
  if (!perImage.length) return;                 // nothing labeled — report-only
  if (args.only) {
    console.log('\n(baseline gate skipped: --only runs a partial corpus)');
    return;
  }

  const current = summarizeRun();

  if (args.update) {
    writeFileSync(BASELINE_PATH, JSON.stringify({
      _README: 'Accuracy regression baseline — seeded by `node scripts/accuracy-tests.mjs --update`. Commit it. Lower is better; the suite fails when a run is worse than these numbers beyond the gate epsilons.',
      updatedAt: new Date().toISOString(),
      ...current,
    }, null, 2) + '\n');
    console.log(`\nBaseline updated: ${path.relative(appDir, BASELINE_PATH)} (${current.overall.images} images, ${current.overall.scored} anchors, overall mean ${current.overall.mean})`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.log('\nNo accuracy baseline yet — regression gate inactive.');
    console.log('Seed it with: node scripts/accuracy-tests.mjs --update  (then commit the file)');
    return;
  }

  const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  const improvements = [];

  for (const [image, b] of Object.entries(base.perImage || {})) {
    const c = current.perImage[image];
    if (!c) { failures.push(`${image}: in baseline but not scored this run (demo image or ground truth removed?) — re-seed with --update if intentional`); continue; }
    if (c.mean > b.mean + GATE_MEAN_EPS) failures.push(`${image}: mean error ${c.mean} regressed past baseline ${b.mean} (+${GATE_MEAN_EPS} allowed)`);
    if (c.max > b.max + GATE_MAX_EPS) failures.push(`${image}: max error ${c.max} regressed past baseline ${b.max} (+${GATE_MAX_EPS} allowed)`);
    if (c.missing > b.missing) failures.push(`${image}: ${c.missing} ground-truth anchor(s) not seeded (baseline ${b.missing})`);
    if (c.mean < b.mean - GATE_MEAN_EPS) improvements.push(`${image}: mean ${b.mean} -> ${c.mean}`);
  }
  for (const image of Object.keys(current.perImage)) {
    if (!(base.perImage || {})[image]) failures.push(`${image}: labeled but missing from baseline — lock it in with --update`);
  }
  for (const [kind, b] of Object.entries(base.perKind || {})) {
    const c = current.perKind[kind];
    if (!c) continue; // kind disappearing shows up as per-image missing/scored drift
    if (c.mean > b.mean + GATE_KIND_EPS) failures.push(`anchor kind ${kind}: mean error ${c.mean} regressed past baseline ${b.mean} (+${GATE_KIND_EPS} allowed)`);
  }
  if (base.overall && current.overall.mean > base.overall.mean + GATE_MEAN_EPS) {
    failures.push(`overall: mean error ${current.overall.mean} regressed past baseline ${base.overall.mean}`);
  }

  console.log('\n--- regression gate (vs committed baseline) ---');
  if (failures.length) {
    for (const f of failures) console.log(`  GATE FAIL  ${f}`);
    console.log('\nAccuracy regressed vs scripts/groundtruth/accuracy-baseline.json.');
    console.log('If this change is intentionally better overall (verify the numbers above),');
    console.log('re-seed with: node scripts/accuracy-tests.mjs --update');
    process.exitCode = 1;
  } else {
    console.log(`  OK — no image, anchor kind, or overall regression (baseline of ${base.updatedAt || 'unknown date'})`);
    if (improvements.length) {
      console.log('  Improvements detected — consider locking them in with --update:');
      for (const i of improvements) console.log(`    + ${i}`);
    }
  }
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }

function printReport() {
  console.log('\n=== Auto Mode accuracy (detector seed vs. TD ground truth) ===');
  console.log(`tolerances: tight=${TOL_TIGHT}  loose=${TOL_LOOSE}  (normalized image units)\n`);

  if (threw.length) {
    console.log('DETECTION ERRORS:');
    for (const t of threw) console.log(`  ! ${t.image}: ${t.msg}`);
    console.log('');
    process.exitCode = 1;
  }

  if (!perImage.length) {
    console.log('No labeled fixtures yet — nothing to score.');
    console.log('Detection ran on these images (plumbing OK); they need ground truth:');
    for (const u of unlabeled) console.log(`  - ${u.image}  (${u.anchorCount} anchors detected)`);
    console.log('\nTo label: open index.html?label=1, add the image, Detect Sketch, drag every');
    console.log(`anchor onto the real landmark, click "Save Ground Truth", and drop the file in`);
    console.log(`scripts/groundtruth/  (named e.g. ${path.basename(images[0])}.json). See its README.`);
    return;
  }

  // Per-image summary
  const allErrs = [];
  for (const r of perImage) {
    const errVals = r.errs.map(e => e.err);
    allErrs.push(...errVals);
    const tight = errVals.filter(e => e <= TOL_TIGHT).length;
    const loose = errVals.filter(e => e <= TOL_LOOSE).length;
    const n = errVals.length || 1;
    console.log(
      `${r.image.padEnd(16)} mean=${mean(errVals).toFixed(4)} p90=${p90(errVals).toFixed(4)} ` +
      `max=${r.maxErr.toFixed(4)}  within tight=${pct(tight, n)} loose=${pct(loose, n)}` +
      (r.missing.length ? `  MISSING:${r.missing.length}` : '') +
      (r.extra.length ? `  extra:${r.extra.length}` : '')
    );
    if (args.verbose) {
      for (const e of r.errs.slice(0, 6)) {
        const flag = e.err > TOL_LOOSE ? ' <-- over loose' : (e.err > TOL_TIGHT ? ' (over tight)' : '');
        console.log(`     ~ ${e.kind.padEnd(20)} ${e.err.toFixed(4)}${flag}`);
      }
      if (r.missing.length) console.log(`     ! not seeded: ${r.missing.join(', ')}`);
    }
  }

  // Per-anchor-kind leaderboard (worst first) — tells you which anchors the
  // detector is reliably bad at, i.e. where tuning effort pays off.
  console.log('\n--- worst anchor kinds (mean error across labeled images) ---');
  const kindRows = [...perKind.entries()]
    .map(([kind, errs]) => ({ kind, n: errs.length, mean: mean(errs), p90: p90(errs) }))
    .sort((a, b) => b.mean - a.mean);
  for (const k of kindRows) {
    console.log(`  ${k.kind.padEnd(20)} mean=${k.mean.toFixed(4)} p90=${k.p90.toFixed(4)} n=${k.n}`);
  }

  // Overall
  const tightAll = allErrs.filter(e => e <= TOL_TIGHT).length;
  const looseAll = allErrs.filter(e => e <= TOL_LOOSE).length;
  console.log('\n--- overall ---');
  console.log(`labeled images : ${perImage.length}   scored anchors: ${allErrs.length}`);
  console.log(`mean error     : ${mean(allErrs).toFixed(4)}`);
  console.log(`median error   : ${median(allErrs).toFixed(4)}`);
  console.log(`p90 error      : ${p90(allErrs).toFixed(4)}`);
  console.log(`within tight   : ${pct(tightAll, allErrs.length)}  (<= ${TOL_TIGHT})`);
  console.log(`within loose   : ${pct(looseAll, allErrs.length)}  (<= ${TOL_LOOSE})`);

  if (unlabeled.length) {
    console.log(`\n${unlabeled.length} image(s) still unlabeled: ${unlabeled.map(u => path.basename(u.image)).join(', ')}`);
  }
}

// ---- stats helpers --------------------------------------------------------
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function median(a) { return pctile(a, 0.5); }
function p90(a) { return pctile(a, 0.9); }
function pctile(a, q) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.floor(q * (s.length - 1)));
  return s[i];
}
function pct(n, total) { return total ? `${Math.round((100 * n) / total)}%` : 'n/a'; }

// ---- in-page capture ------------------------------------------------------
function captureExpr(imagePath, auxPaths) {
  return `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const toDataURL = async (p) => {
        const res = await fetch(p + '?accuracy=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('fetch ' + p + ' ' + res.status);
        const blob = await res.blob();
        return await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || '')); r.onerror = () => no(new Error('read')); r.readAsDataURL(blob); });
      };
      const dataURL = await toDataURL(${JSON.stringify(imagePath)});
      // Extra board photos, when the ground truth declares a multi-photo board.
      // The primary stays the detection source; each extra becomes an aux view.
      const auxPaths = ${JSON.stringify(auxPaths || [])};
      const auxDataURLs = [];
      for (const p of auxPaths) auxDataURLs.push(await toDataURL(p));
      const result = await debug.runAutoOnDataUrl(dataURL, auxDataURLs.length ? { auxDataURLs } : undefined);
      const anchors = {};
      for (const a of (result.anchors || [])) {
        anchors[a.kind] = {
          x: Math.round(a.x * 1e6) / 1e6,
          y: Math.round(a.y * 1e6) / 1e6,
          viewRole: a.viewRole || null,
          confidence: a.confidence || null,
        };
      }
      const det = result.detection || {};
      return {
        anchors,
        quality: typeof det.quality === 'number' ? Math.round(det.quality * 1e4) / 1e4 : null,
      };
    })()
  `;
}

// ---- CDP plumbing (mirrors golden-tests.mjs) ------------------------------
function parseArgs(argv) {
  const p = {};
  for (const a of argv) {
    if (a === '--verbose') p.verbose = true;
    else if (a === '--update') p.update = true;
    else if (a.startsWith('--chrome=')) p.chrome = a.slice(9);
    else if (a.startsWith('--only=')) p.only = a.slice(7);
    else if (a.startsWith('--tol=')) process.env.ACCURACY_TOL = a.slice(6);
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
