#!/usr/bin/env node
// US-124 Phase 5 (ADR 0091): DXF Worker — behaviour-preservation, routing,
// cancel and fallback proof. Modelled on auto-seam-worker-check.mjs.
//
// What IS asserted (hard failures):
//   - The worker is supported in the headless Chrome the suites run in.
//   - For EVERY corpus file in scripts/dxf-corpus-oracle.json (fed the same
//     bytes the real picker sees, via dxf.decodeBytes) and for synthetic
//     130 / 240 / 500-instance nests, the worker's parseDxfDocument AND
//     parseDxfNativeModel results are BYTE-IDENTICAL (JSON) to the
//     synchronous main-thread results. Same parts, same functions, same
//     text, same answer — this is the whole point of the split.
//   - Routing: ≤120 estimated instances stays synchronous (reason
//     'under-threshold'); >120 goes to the worker (reason 'ok'); the
//     estimate equals the INSERT count.
//   - The REAL import path (File ▸ Open project… picker) of a 130-instance
//     file records engine 'worker', shows the progress dialog, places every
//     piece, builds the native session from the worker's precomputed model
//     ('worker-precomputed'), and closes the dialog.
//   - Cancel: cancelling mid-parse leaves the board empty, records reason
//     'cancelled', and the NEXT import still works (the worker is re-created).
//   - Fallback branch 1: setEnabled(false) -> engine 'main-thread', reason
//     'worker-disabled', identical board. Fallback branch 2: a missing worker
//     URL -> engine 'main-thread', reason 'worker-failed: …', identical
//     board; re-enabling restores the worker. Never silent.
//   - Responsiveness: a 10 ms interval keeps ticking on the main thread while
//     the worker parses the largest fixture.
// What is reported only: wall time per fixture, sync vs worker.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessApp } from './headless-app.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let app;
let assertions = 0;
const check = (condition, message) => { if (!condition) throw new Error(message); assertions += 1; };

// ---- synthetic nests (Node-side text builders) ------------------------------
const P = (code, value) => `${code}\n${value}\n`;
// n INSERT-placed blocks, each a closed layer-1 square (one classified
// pattern) with a CLO-style annotation; block names carry S/M/L size tokens.
function syntheticNest(n) {
  let blocks = '';
  let ents = '';
  const sizes = ['S', 'M', 'L'];
  for (let i = 0; i < n; i += 1) {
    const name = `PIECE${i}_${sizes[i % 3]}`;
    blocks += P(0, 'BLOCK') + P(8, '0') + P(2, name) + P(70, 0) + P(10, 0) + P(20, 0)
      + P(0, 'LWPOLYLINE') + P(8, '1') + P(90, 4) + P(70, 1)
      + P(10, 0) + P(20, 0) + P(10, 100) + P(20, 0) + P(10, 100) + P(20, 100) + P(10, 0) + P(20, 100)
      + P(0, 'LINE') + P(8, '7') + P(10, -20) + P(20, 50) + P(11, 120) + P(21, 50)
      + P(0, 'TEXT') + P(8, '1') + P(10, 5) + P(20, 5) + P(40, 2) + P(1, `PIECE NAME: PIECE${i}`)
      + P(0, 'ENDBLK');
    ents += P(0, 'INSERT') + P(8, '0') + P(2, name) + P(10, (i % 20) * 200) + P(20, Math.floor(i / 20) * 200);
  }
  return P(0, 'SECTION') + P(2, 'BLOCKS') + blocks + P(0, 'ENDSEC') + P(0, 'SECTION') + P(2, 'ENTITIES') + ents + P(0, 'ENDSEC') + P(0, 'EOF');
}

async function main() {
  app = await launchHeadlessApp({ appDir, query: 'dxf-worker', profilePrefix: 'dxf-worker-' });
  const { session } = app;
  await session.eval(`window.__dxfwErrors=[];addEventListener('error',e=>window.__dxfwErrors.push(String(e.message||e.error)))`);
  await session.eval(`window.__DXFW = (() => {
    const d = window.__braAutoModeDebug;
    const settle = (n) => new Promise(r => setTimeout(r, n || 120));
    const reset = async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; p.state.graphics = []; p.state.notes = [];
      await d.loadProject(p);
      document.getElementById('modeManualBtn').click();
      if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    };
    const pick = (text, name) => {
      const input = document.getElementById('projectFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([text], name || 'nest.dxf', { type: 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const waitFor = async (fn, ms) => { const end = Date.now() + (ms || 20000); while (Date.now() < end) { if (fn()) return true; await settle(50); } return false; };
    return { d, settle, reset, pick, waitFor };
  })()`);

  check(await session.eval('window.__braAutoModeDebug.dxf.worker.supported()') === true,
    'headless Chrome must support Worker, and app.js must carry DXF_WORKER_URL');

  // ---- 1. Corpus identity ----------------------------------------------------
  const oraclePath = path.join(appDir, 'scripts', 'dxf-corpus-oracle.json');
  const corpusDir = path.join(appDir, 'demo', 'DXF file');
  const timings = [];
  let largestPath = null, largestLines = -1;
  if (existsSync(oraclePath) && existsSync(corpusDir)) {
    const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
    for (const row of oracle.files) {
      const r = await session.eval(`(async () => {
        const d = window.__braAutoModeDebug.dxf;
        const res = await fetch('/' + encodeURI(${JSON.stringify(row.path)}));
        if (!res.ok) return { missing: true };
        const text = d.decodeBytes(await res.arrayBuffer()).text;
        const t0 = performance.now();
        const syncBoard = d.parse(text); const syncNative = d.parseNative(text);
        const syncMs = performance.now() - t0;
        const t1 = performance.now();
        const w = await d.worker.parse(text);
        const workerMs = performance.now() - t1;
        return {
          boardEqual: JSON.stringify(syncBoard) === JSON.stringify(w.board),
          nativeEqual: JSON.stringify(syncNative) === JSON.stringify(w.native),
          pieces: syncBoard.ok ? syncBoard.pieces.length : null,
          lines: syncBoard.ok ? syncBoard.pieces.reduce((s, p) => s + p.length, 0) : null,
          syncMs, workerMs, progressEvents: w.progressEvents,
        };
      })()`);
      if (r.missing) { console.log(`SKIP  dxf-worker-check   ${row.path} not present`); continue; }
      check(r.boardEqual, `${row.path}: worker parseDxfDocument result must be byte-identical to the synchronous one`);
      check(r.nativeEqual, `${row.path}: worker parseDxfNativeModel result must be byte-identical to the synchronous one`);
      check(r.pieces === row.patterns, `${row.path}: expected ${row.patterns} patterns, got ${r.pieces}`);
      timings.push({ file: path.basename(row.path), pieces: r.pieces, syncMs: Math.round(r.syncMs), workerMs: Math.round(r.workerMs), progress: r.progressEvents });
      if (r.lines > largestLines) { largestLines = r.lines; largestPath = row.path; }
    }
  } else {
    console.log('SKIP  dxf-worker-check   corpus oracle or demo/DXF file absent (public mirror) — corpus identity skipped');
  }

  // ---- 2. Synthetic identity + routing -----------------------------------------
  for (const n of [5, 130, 240, 500]) {
    const text = syntheticNest(n);
    const r = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug.dxf;
      const text = ${JSON.stringify(text)};
      const route = d.worker.route(text);
      const syncBoard = d.parse(text); const syncNative = d.parseNative(text);
      const w = await d.worker.parse(text);
      return { route, boardEqual: JSON.stringify(syncBoard) === JSON.stringify(w.board), nativeEqual: JSON.stringify(syncNative) === JSON.stringify(w.native),
        pieces: syncBoard.pieces.length, over: syncBoard.stats.overBatchThreshold, progress: w.progressEvents };
    })()`);
    check(r.boardEqual && r.nativeEqual, `synthetic ${n}-instance nest: worker results must equal the synchronous ones`);
    check(r.pieces === n && r.route.estimate === n, `synthetic ${n}: ${n} patterns and an INSERT estimate of ${n}, got ${JSON.stringify({ pieces: r.pieces, route: r.route })}`);
    check(r.route.useWorker === (n > 120) && (n > 120 ? r.route.reason === 'ok' : r.route.reason === 'under-threshold'),
      `synthetic ${n}: routing must be ${n > 120 ? 'worker' : 'synchronous'}, got ${JSON.stringify(r.route)}`);
    if (n > 120) check(r.progress >= 1, `synthetic ${n}: the worker must post progress, got ${r.progress}`);
  }

  // ---- 3. Real import path through the picker ---------------------------------
  const nest130 = syntheticNest(130);
  const realImport = await session.eval(`(async () => {
    const h = window.__DXFW, d = h.d;
    await h.reset();
    d.dxf.worker.setEnabled(true); d.dxf.worker.setForce(false);
    h.pick(${JSON.stringify(nest130)}, 'nest130.dxf');
    await h.settle(30);
    const dialogSeen = !!document.querySelector('.picker-overlay.dxf-import-progress');
    const done = await h.waitFor(() => d.getAnnotations().length > 0 && !document.querySelector('.picker-overlay.dxf-import-progress'), 30000);
    const ex = d.dxf.worker.lastExecution();
    const s = d.dxf.measure.getSession();
    return { dialogSeen, done, execution: ex, groups: d.dxf.patternPieces.groups().length, anns: d.getAnnotations().length,
      sessionPieces: s && s.pieceCount, nativeExecution: s && s.source && s.source.nativeParserExecution, dialogGone: !document.querySelector('.picker-overlay.dxf-import-progress') };
  })()`);
  check(realImport.done && realImport.execution && realImport.execution.engine === 'worker' && realImport.execution.reason === 'ok' && realImport.execution.estimate === 130,
    `a 130-instance file picked through the real input must import via the worker, got ${JSON.stringify(realImport)}`);
  check(realImport.groups === 130 && realImport.anns === 130 * 5 && realImport.sessionPieces === 130 && realImport.nativeExecution === 'worker-precomputed' && realImport.dialogGone,
    `the worker import must place 130 patterns (5 lines each), build the native session from the precomputed model, and close the progress dialog, got ${JSON.stringify(realImport)}`);
  console.log(`INFO  dxf-worker-check   real 130-instance import via worker: ${realImport.execution.elapsedMs} ms, ${realImport.execution.progressEvents} progress events, dialog observed mid-parse: ${realImport.dialogSeen}`);

  // ---- 4. Cancel ---------------------------------------------------------------
  // A 500-instance nest of tiny squares parses in ~12 ms — too fast to cancel
  // (the first run of this suite proved it). The heavy fixture is four
  // no-layer blocks of 6,000 lines each: the legacy O(n²) grouping per
  // instance takes seconds, which is exactly the tab-freezing case the worker
  // exists for. Its INSERT estimate is 4, so the route is forced for this
  // section only. The progress dialog opens after FileReader's async read, so
  // the test waits for it (≤ 3 s) before pressing the REAL Cancel button.
  const heavyNest = (() => {
    let blocks = '', ents = '';
    for (let b = 0; b < 4; b += 1) {
      blocks += P(0, 'BLOCK') + P(8, '0') + P(2, 'HEAVY' + b) + P(70, 0) + P(10, 0) + P(20, 0);
      for (let i = 0; i < 6000; i += 1) blocks += P(0, 'LINE') + P(10, i) + P(20, 0) + P(11, i + 1) + P(21, 0);
      blocks += P(0, 'ENDBLK');
      ents += P(0, 'INSERT') + P(8, '0') + P(2, 'HEAVY' + b) + P(10, 0) + P(20, b * 100);
    }
    return P(0, 'SECTION') + P(2, 'BLOCKS') + blocks + P(0, 'ENDSEC') + P(0, 'SECTION') + P(2, 'ENTITIES') + ents + P(0, 'ENDSEC') + P(0, 'EOF');
  })();
  const cancelRun = await session.eval(`(async () => {
    const h = window.__DXFW, d = h.d;
    await h.reset();
    d.dxf.worker.setForce(true);
    const before = JSON.stringify(d.getAnnotations());
    h.pick(${JSON.stringify(heavyNest)}, 'heavy.dxf');
    const appeared = await h.waitFor(() => !!document.querySelector('.picker-overlay.dxf-import-progress'), 3000);
    const overlay = document.querySelector('.picker-overlay.dxf-import-progress');
    const btn = overlay && overlay.querySelector('.dxf-import-progress-cancel');
    if (btn) btn.click();
    await h.settle(800);
    d.dxf.worker.setForce(false);
    const ex = d.dxf.worker.lastExecution();
    const afterCancel = { appeared, anns: d.getAnnotations().length, unchanged: JSON.stringify(d.getAnnotations()) === before, dialogGone: !document.querySelector('.picker-overlay.dxf-import-progress'), reason: ex && ex.reason, hadDialog: !!overlay };
    // Nothing may land later either: the worker was terminated, not just ignored.
    await h.settle(2500);
    afterCancel.stillEmptyLater = d.getAnnotations().length === 0;
    // The next import must still work (worker re-created after terminate()).
    h.pick(${JSON.stringify(nest130)}, 'nest130-again.dxf');
    const done = await h.waitFor(() => d.getAnnotations().length > 0 && !document.querySelector('.picker-overlay.dxf-import-progress'), 30000);
    const ex2 = d.dxf.worker.lastExecution();
    return { afterCancel, next: { done, engine: ex2 && ex2.engine, reason: ex2 && ex2.reason, groups: d.dxf.patternPieces.groups().length } };
  })()`);
  check(cancelRun.afterCancel.appeared && cancelRun.afterCancel.hadDialog && cancelRun.afterCancel.anns === 0 && cancelRun.afterCancel.unchanged
    && cancelRun.afterCancel.dialogGone && cancelRun.afterCancel.reason === 'cancelled' && cancelRun.afterCancel.stillEmptyLater,
    `Cancel mid-parse must leave the board untouched (also later — the worker is terminated) and record reason 'cancelled', got ${JSON.stringify(cancelRun.afterCancel)}`);
  check(cancelRun.next.done && cancelRun.next.engine === 'worker' && cancelRun.next.reason === 'ok' && cancelRun.next.groups === 130,
    `the import after a cancel must still run in a fresh worker, got ${JSON.stringify(cancelRun.next)}`);

  // ---- 5. Fallbacks (never silent) -------------------------------------------
  const fallbacks = await session.eval(`(async () => {
    const h = window.__DXFW, d = h.d;
    const importAndRead = async (name) => {
      await h.reset();
      h.pick(${JSON.stringify(nest130)}, name);
      await h.waitFor(() => d.getAnnotations().length > 0 && !document.querySelector('.picker-overlay.dxf-import-progress'), 30000);
      const ex = d.dxf.worker.lastExecution();
      return { engine: ex && ex.engine, reason: ex && ex.reason, groups: d.dxf.patternPieces.groups().length, anns: d.getAnnotations().length };
    };
    d.dxf.worker.setEnabled(false);
    const disabled = await importAndRead('disabled.dxf');
    d.dxf.worker.setEnabled(true);
    d.dxf.worker.setUrl('missing-dxf-worker.js');
    const broken = await importAndRead('broken.dxf');
    const brokenAgain = d.dxf.worker.route(${JSON.stringify(nest130)});
    d.dxf.worker.setUrl(null);
    d.dxf.worker.setEnabled(true);
    const restored = await importAndRead('restored.dxf');
    return { disabled, broken, brokenAgain, restored };
  })()`);
  check(fallbacks.disabled.engine === 'main-thread' && fallbacks.disabled.reason === 'worker-disabled' && fallbacks.disabled.groups === 130 && fallbacks.disabled.anns === 650,
    `with the worker disabled the import must run in-thread, say so, and place the same board, got ${JSON.stringify(fallbacks.disabled)}`);
  check(fallbacks.broken.engine === 'main-thread' && /^worker-failed/.test(fallbacks.broken.reason || '') && fallbacks.broken.groups === 130 && fallbacks.broken.anns === 650,
    `a missing worker file must fall back in-thread with a 'worker-failed: …' reason and the same board, got ${JSON.stringify(fallbacks.broken)}`);
  check(fallbacks.brokenAgain.useWorker === false && fallbacks.brokenAgain.reason === 'worker-failed-earlier',
    `after a failure the route must stay in-thread for the session (sticky), got ${JSON.stringify(fallbacks.brokenAgain)}`);
  check(fallbacks.restored.engine === 'worker' && fallbacks.restored.reason === 'ok' && fallbacks.restored.groups === 130,
    `re-enabling must restore the worker route, got ${JSON.stringify(fallbacks.restored)}`);

  // ---- 6. Responsiveness --------------------------------------------------------
  const responsive = await session.eval(`(async () => {
    const d = window.__braAutoModeDebug.dxf;
    let text;
    if (${JSON.stringify(largestPath)}) {
      const res = await fetch('/' + encodeURI(${JSON.stringify(largestPath)}));
      text = d.decodeBytes(await res.arrayBuffer()).text;
    } else text = ${JSON.stringify(heavyNest)};
    let ticks = 0; const iv = setInterval(() => { ticks += 1; }, 10);
    const t0 = performance.now();
    await d.worker.parse(text);
    const workerMs = performance.now() - t0;
    clearInterval(iv);
    let syncTicks = 0; const iv2 = setInterval(() => { syncTicks += 1; }, 10);
    const t1 = performance.now();
    d.parse(text); d.parseNative(text);
    const syncMs = performance.now() - t1;
    await new Promise(r => setTimeout(r, 0));
    clearInterval(iv2);
    return { fixture: ${JSON.stringify(largestPath || 'synthetic-500')}, ticks, workerMs: Math.round(workerMs), syncTicks, syncMs: Math.round(syncMs) };
  })()`);
  check(responsive.ticks >= 5, `the main thread must keep ticking while the worker parses ${responsive.fixture} (${responsive.workerMs} ms), got ${responsive.ticks} ticks`);
  console.log(`INFO  dxf-worker-check   responsiveness on ${responsive.fixture}: worker ${responsive.workerMs} ms with ${responsive.ticks} main-thread ticks; synchronous ${responsive.syncMs} ms with ${responsive.syncTicks} ticks`);

  for (const t of timings) console.log(`INFO  dxf-worker-check   ${t.file}: ${t.pieces} patterns, sync ${t.syncMs} ms, worker ${t.workerMs} ms, ${t.progress} progress events`);

  const errors = await session.eval('window.__dxfwErrors || []');
  check(errors.length === 0, 'browser console errors: ' + errors.join(' | '));
  console.log(`PASS  dxf-worker-check   ${assertions}/${assertions} assertions ok`);
}

try { await main(); } catch (error) { process.exitCode = 1; console.error('FAIL', error && error.message ? error.message : error); }
finally { if (app) await app.close(); }
