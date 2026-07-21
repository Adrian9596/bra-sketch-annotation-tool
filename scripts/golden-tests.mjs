#!/usr/bin/env node
// Golden-fixture detection harness.
//
// Runs auto-mode sketch detection on EVERY demo/*.jpg in a headless Chrome and
// compares the resulting anchors (normalized, keyed by kind), draft count,
// per-POM draft-line GEOMETRY (start/end/control points, normalized to the
// source image), and detection.quality against committed per-image baselines.
// This is the only thing that can answer "did a detection change make things
// better or worse", since the smoke suite only runs one image and checks
// structure. Geometry coverage guards the fixture->draft path that anchor
// drift can't see (e.g. the 2026-07-10 POM 14 NaN control-point bug).
//
//   node scripts/golden-tests.mjs            # compare against baselines (fails on drift)
//   node scripts/golden-tests.mjs --update   # (re)seed baselines from current output
//   GOLDEN_TOL=0.05 node scripts/golden-tests.mjs   # override drift tolerance
//
// Reuses the Chrome + raw-CDP plumbing from auto-mode-smoke.mjs (zero deps).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const goldenDir = path.join(scriptDir, 'golden');

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TOL = Number(process.env.GOLDEN_TOL || 0.04);   // max normalized Euclidean anchor drift
const QUALITY_SLACK = Number(process.env.GOLDEN_QUALITY_SLACK || 0.02);

const args = parseArgs(process.argv.slice(2));
const chromePath = args.chrome || process.env.CHROME_PATH || DEFAULT_CHROME;
const update = Boolean(args.update);

if (!existsSync(chromePath)) fail(`Chrome not found at ${chromePath}. Pass --chrome=/path or set CHROME_PATH.`);

const images = readdirSync(path.join(appDir, 'demo'))
  .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
  .filter(f => !args.only || f.includes(args.only))
  .sort()
  .map(f => `demo/${f}`);
if (!images.length) fail('No demo/*.jpg fixtures found.');

let server, chrome, userDataDir;
const captures = {};
const errors = {};

try {
  const { server: httpServer, baseUrl } = await startStaticServer(appDir);
  server = httpServer;
  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-golden-'));
  const targetUrl = `${baseUrl}/index.html?golden=${Date.now()}&freeCv=1`;

  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking',
    // Pin the harness to the deterministic OFFLINE ink-mask path via the
    // ?freeCv=1 URL param above (opencv.js is vendored + served same-origin
    // now, so a CDN block no longer starves the real backend). The post-mask
    // pipeline (views, rows, landmarks, anchors, drafts) is backend-agnostic,
    // so this gives fast, network-free, reproducible baselines. The shipped
    // app still uses the real WASM backend; only this runner forces the free
    // path. The resolver rule stays as belt-and-braces against any stray
    // CDN reference.
    '--host-resolver-rules=MAP docs.opencv.org 127.0.0.1:9',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, targetUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', c => { chromeStderr += String(c); });

  const target = await waitForChromeTarget(cdpPort, targetUrl);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  for (const image of images) {
    try {
      // Fresh page per fixture so board state (added images, drafts) never
      // accumulates between detections — accumulation slows/stalls later runs.
      await cdp.send('Page.navigate', { url: targetUrl });
      await waitForDebugApi(cdp);
      // Per-image timeout so one pathological fixture (e.g. a photo, not a
      // flat sketch) can't hang the whole harness.
      captures[image] = await withTimeout(evaluate(cdp, captureExpr(image)), 30000, image);
      if (args.verbose) console.error(`[${image}] ok — anchors=${Object.keys(captures[image].anchors).length} drafts=${captures[image].draftCount} quality=${captures[image].quality}`);
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

if (update) {
  mkdirSync(goldenDir, { recursive: true });
  let wrote = 0;
  for (const image of images) {
    if (errors[image]) { console.error(`SKIP ${image}: detection threw — ${errors[image]}`); continue; }
    writeFileSync(baselinePath(image), JSON.stringify(captures[image], null, 2) + '\n');
    wrote += 1;
  }
  console.log(`Seeded ${wrote}/${images.length} baselines in scripts/golden/.`);
  if (Object.keys(errors).length) process.exitCode = 1;
} else {
  let anyFail = false;
  for (const image of images) {
    const report = compareOne(image);
    printReport(image, report);
    if (!report.ok) anyFail = true;
  }
  console.log(anyFail ? '\nGOLDEN: FAIL' : '\nGOLDEN: PASS');
  if (anyFail) process.exitCode = 1;
}

// ---- comparison ---------------------------------------------------------
function baselinePath(image) { return path.join(goldenDir, image.replace(/[\/]/g, '__') + '.json'); }

function compareOne(image) {
  const r = { image, ok: true, notes: [], drifts: [], roleChanges: [], pomChanges: [] };
  if (errors[image]) { r.ok = false; r.notes.push(`detection THREW: ${errors[image]}`); return r; }
  const cur = captures[image];
  if (!cur) { r.ok = false; r.notes.push('no capture produced'); return r; }
  const bp = baselinePath(image);
  if (!existsSync(bp)) { r.ok = false; r.notes.push('no baseline (run --update to seed)'); return r; }
  const base = JSON.parse(readFileSync(bp, 'utf8'));

  if (cur.draftCount !== base.draftCount) { r.ok = false; r.notes.push(`draftCount ${base.draftCount} -> ${cur.draftCount}`); }
  if (base.quality != null && cur.quality != null && cur.quality < base.quality - QUALITY_SLACK) {
    r.ok = false; r.notes.push(`quality ${base.quality} -> ${cur.quality} (regressed)`);
  }
  if (base.acceptedWithoutEditCandidates != null
      && cur.acceptedWithoutEditCandidates < base.acceptedWithoutEditCandidates) {
    r.ok = false;
    r.notes.push(`acceptedWithoutEditCandidates ${base.acceptedWithoutEditCandidates} -> ${cur.acceptedWithoutEditCandidates} (regressed)`);
  }
  const baseKinds = Object.keys(base.anchors).sort();
  const curKinds = Object.keys(cur.anchors).sort();
  const missing = baseKinds.filter(k => !curKinds.includes(k));
  const added = curKinds.filter(k => !baseKinds.includes(k));
  if (missing.length) { r.ok = false; r.notes.push(`anchors removed: ${missing.join(', ')}`); }
  if (added.length) { r.ok = false; r.notes.push(`anchors added: ${added.join(', ')}`); }

  for (const k of baseKinds) {
    if (!cur.anchors[k]) continue;
    const a = base.anchors[k], b = cur.anchors[k];
    const drift = Math.hypot(b.x - a.x, b.y - a.y);
    if (drift > 1e-9) r.drifts.push({ kind: k, drift });
    if (drift > TOL) r.ok = false;
    if (a.viewRole !== b.viewRole || a.confidence !== b.confidence) {
      r.roleChanges.push(`${k}: role ${a.viewRole}->${b.viewRole}, conf ${a.confidence}->${b.confidence}`);
    }
  }
  if (base.poms && cur.poms) {
    for (const pom of Object.keys(base.poms).sort((a, b) => Number(a) - Number(b))) {
      if (!cur.poms[pom]) {
        r.ok = false;
        r.pomChanges.push(`POM ${pom}: removed from draft summary`);
        continue;
      }
      const before = base.poms[pom];
      const after = cur.poms[pom];
      if (before.drawability !== after.drawability || before.confidence !== after.confidence) {
        r.pomChanges.push(`POM ${pom}: ${before.drawability}/${before.confidence} -> ${after.drawability}/${after.confidence}`);
      }
      if (before.acceptedWithoutEditCandidate && !after.acceptedWithoutEditCandidate) {
        r.ok = false;
        r.pomChanges.push(`POM ${pom}: no-edit acceptance candidate lost`);
      }
      // Draft-geometry drift: compare each geometry point with the same
      // tolerance as anchors, reported as pom{n}.{point} in the drift list.
      // Baselines seeded before this field exists skip silently (re-seed with
      // --update to arm). A point present in one capture but not the other is
      // a hard fail — geometry appearing/vanishing is never benign.
      if (before.geometry && after.geometry) {
        if (before.geometry.type !== after.geometry.type) {
          r.ok = false;
          r.pomChanges.push(`POM ${pom}: type ${before.geometry.type} -> ${after.geometry.type}`);
        }
        for (const pt of ['start', 'end', 'control1', 'control2']) {
          const a = before.geometry[pt], b = after.geometry[pt];
          if (!a && !b) continue;
          if (!a || !b) {
            r.ok = false;
            r.pomChanges.push(`POM ${pom}: ${pt} ${a ? 'lost' : 'appeared'}`);
            continue;
          }
          const drift = Math.hypot(b.x - a.x, b.y - a.y);
          if (drift > 1e-9) r.drifts.push({ kind: `pom${pom}.${pt}`, drift });
          if (drift > TOL) r.ok = false;
        }
      } else if (!!before.geometry !== !!after.geometry) {
        r.ok = false;
        r.pomChanges.push(`POM ${pom}: geometry ${before.geometry ? 'lost' : 'appeared'} (drawability flip?)`);
      }
    }
  }
  r.drifts.sort((x, y) => y.drift - x.drift);
  return r;
}

function printReport(image, r) {
  const max = r.drifts.length ? r.drifts[0].drift : 0;
  console.log(`\n${r.ok ? 'PASS' : 'FAIL'}  ${image}   maxDrift=${max.toFixed(4)} (tol ${TOL})`);
  for (const n of r.notes) console.log(`   ! ${n}`);
  for (const d of r.drifts.slice(0, 8)) {
    const flag = d.drift > TOL ? ' <-- OVER TOL' : '';
    console.log(`   ~ ${d.kind.padEnd(22)} ${d.drift.toFixed(4)}${flag}`);
  }
  if (r.roleChanges.length && args.verbose) for (const c of r.roleChanges) console.log(`   . ${c}`);
  if (r.pomChanges.length && args.verbose) for (const c of r.pomChanges) console.log(`   . ${c}`);
}

// ---- in-page capture ----------------------------------------------------
function captureExpr(imagePath) {
  return `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const res = await fetch(${JSON.stringify(imagePath)} + '?golden=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch ' + res.status);
      const blob = await res.blob();
      const dataURL = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result || '')); r.onerror = () => no(new Error('read')); r.readAsDataURL(blob); });
      const result = await debug.runAutoOnDataUrl(dataURL);
      const det = result.detection || {};
      const drafts = result.drafts || [];
      // Drafts are world-space; normalize back to source-image space so the
      // baseline survives board layout changes. The source image is the last
      // one added by runAutoOnDataUrl.
      const img = (result.images || [])[(result.images || []).length - 1] || null;
      const normPt = (p) => (p && img)
        ? { x: Math.round(((p.x - img.x) / img.width) * 1e6) / 1e6,
            y: Math.round(((p.y - img.y) / img.height) * 1e6) / 1e6 }
        : null;
      const poms = {};
      let acceptedWithoutEditCandidates = 0;
      for (const d of drafts) {
        const pom = String(d.text != null ? d.text : d.seq);
        const drawable = d.drawability !== 'REVIEW_ONLY';
        const acceptedCandidate = drawable && !d.tdEdited;
        if (acceptedCandidate) acceptedWithoutEditCandidates += 1;
        poms[pom] = {
          drawability: d.drawability || null,
          confidence: d.confidence || null,
          acceptedWithoutEditCandidate: acceptedCandidate,
          // Draft-line geometry (normalized). REVIEW_ONLY rows have null
          // geometry by contract; control points exist only on curved lines.
          // Guards the fixture->draft path that anchor drift can't see (e.g.
          // the 2026-07-10 POM 14 NaN control-point bug).
          geometry: drawable ? {
            type: d.type || 'straight',
            start: normPt(d.start),
            end: normPt(d.end),
            control1: normPt(d.control1),
            control2: normPt(d.control2),
          } : null,
        };
      }
      const anchors = {};
      for (const a of (result.anchors || [])) {
        anchors[a.kind] = {
          x: Math.round(a.x * 1e6) / 1e6,
          y: Math.round(a.y * 1e6) / 1e6,
          viewRole: a.viewRole || null,
          confidence: a.confidence || null,
        };
      }
      const viewCount = Array.isArray(det.viewBoxes) ? det.viewBoxes.length
        : (Array.isArray(det.views) ? det.views.length : null);
      return {
        anchors,
        draftCount: drafts.length,
        acceptedWithoutEditCandidates,
        poms,
        quality: typeof det.quality === 'number' ? Math.round(det.quality * 1e4) / 1e4 : null,
        viewCount,
      };
    })()
  `;
}

// ---- CDP plumbing (mirrors auto-mode-smoke.mjs) -------------------------
function parseArgs(argv) {
  const p = {};
  for (const a of argv) {
    if (a === '--update') p.update = true;
    else if (a === '--verbose') p.verbose = true;
    else if (a.startsWith('--chrome=')) p.chrome = a.slice(9);
    else if (a.startsWith('--only=')) p.only = a.slice(7);
    else if (a.startsWith('--tol=')) process.env.GOLDEN_TOL = a.slice(6);
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
  // Poll from the node side so it survives the execution-context destruction
  // that happens during a Page.navigate (an in-page setInterval would die).
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
