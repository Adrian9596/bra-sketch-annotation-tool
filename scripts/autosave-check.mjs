#!/usr/bin/env node
// End-to-end verification of the autosave / restore-on-reload flow.
// Boots the app in headless Chrome, injects a state edit via the app's
// public helpers, waits for the debounced autosave, then reloads and
// asserts the restore banner shows and Restore recovers the annotation.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let server, chrome, userDataDir;
const cleanupTasks = [];

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  const baseUrl = started.baseUrl;
  cleanupTasks.push(() => new Promise((r) => server.close(r)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'autosave-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));

  const chromeArgs = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `${baseUrl}/index.html?smoke=${Date.now()}`,
  ];
  chrome = spawn(CHROME, chromeArgs);
  cleanupTasks.push(() => new Promise((r) => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const session = await openCdpSession(cdpPort);

  // Wait for the app to be up: renderSpecPanel has rendered rows.
  await session.waitFor(`document.querySelectorAll('#specBody tr').length > 0`, 8000);

  // Step 1 — load a synthetic project with one annotation. loadProject
  // deliberately clears the autosave slot; we then flush the autosave
  // manually to re-write from the loaded state.
  const seeded = await session.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    if (!api || typeof api.loadProject !== 'function') return { ok: false, reason: 'no debug api' };
    await api.loadProject({
      format: 'bra-sketch-project',
      version: 1,
      savedAt: new Date().toISOString(),
      state: {
        annotations: [{
          id: 1, seq: 1, type: 'straight',
          start: { x: 100, y: 100 }, end: { x: 200, y: 200 },
          color: 'red', text: '11', value: null, desc: null,
        }],
        images: [], eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'cm' },
        nextSequence: 2, idCounter: 2,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0, styleId: '', pomSpecs: {},
      },
    });
    api.autosave.flush();
    return { ok: true };
  })()`);
  assert(seeded.ok, 'Could not seed annotation: ' + (seeded.reason || 'unknown'));

  // Step 2 — confirm localStorage now holds a record for the annotation.
  const savedRaw = await session.eval(`window.__braAutoModeDebug.autosave.peek()`);
  assert(!!savedRaw, 'autosave record was not written to localStorage');
  const saved = JSON.parse(savedRaw);
  assert(
    saved && saved.snapshot && saved.snapshot.state
      && Array.isArray(saved.snapshot.state.annotations)
      && saved.snapshot.state.annotations.length === 1,
    'autosave snapshot did not include the annotation we seeded'
  );
  assert(saved.snapshot.state.annotations[0].text === '11', 'autosave snapshot lost the annotation label');

  await session.close();

  // Step 3 — reload the tab in a way that preserves localStorage but
  // clears in-memory state. beforeunload dialogs are suppressed in
  // headless mode, so this reload just re-navigates.
  const session2 = await openCdpSession(cdpPort);
  await session2.eval(`window.location.reload()`);
  await sleep(400);
  // Reconnect: after reload the page target has a new websocket URL.
  await session2.close();
  const session3 = await openCdpSession(cdpPort);

  await session3.waitFor(`!!document.getElementById('autosaveRestoreBanner')`, 8000);
  const bannerText = await session3.eval(`document.getElementById('autosaveRestoreBanner').innerText`);
  assert(/Recovered work available/i.test(bannerText), 'restore banner text missing headline');

  // Step 4 — click Restore and confirm the annotation ends up back on
  // the board.
  await session3.eval(`
    Array.from(document.querySelectorAll('#autosaveRestoreBanner button'))
      .find(b => /Restore/i.test(b.textContent))
      .click();
  `);
  // exportProject reflects the live post-restore state.
  await session3.waitFor(`
    !!window.__braAutoModeDebug
    && window.__braAutoModeDebug.exportProject().state.annotations.length === 1
  `, 6000);
  const restoredLabel = await session3.eval(`
    window.__braAutoModeDebug.exportProject().state.annotations[0].text
  `);
  assert(restoredLabel === '11', 'restored annotation lost its label; got ' + restoredLabel);

  // Step 5 — autosave should be cleared after a successful restore so
  // the banner does not re-appear.
  const postRestoreRaw = await session3.eval(`window.__braAutoModeDebug.autosave.peek()`);
  assert(!postRestoreRaw, 'autosave record was not cleared after restore');

  // Step 6 — a project with no Board image/line but with BOM-owned work is
  // saveable and autosaveable. This is the data-loss boundary for TDs who
  // start from the factory table rather than the measurement Board.
  await session3.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    await api.loadProject({
      format: 'bra-sketch-project', version: 1, savedAt: new Date().toISOString(),
      state: {
        annotations: [], images: [], eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'cm' }, nextSequence: 1, idCounter: 10,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0, styleId: '', pomSpecs: {},
        bom: {
          schemaVersion: 2, seedId: 'rsl-vdraft-1.0',
          rows: [{ id: 7, section: 'FABRIC', scope: 'BOTH', groupId: null,
            cells: { description: 'BOM-only edited material', composition: '', supplier: '', article: '', width: '', size: '', areaOfUse: '' },
            cwOverride: {} }],
          callouts: [],
          images: { solid: [{ id: 8, dataURL: '${TINY_PNG}', x: 0, y: 0, width: 300, height: 300, aspect: 1, locked: false }], lace: [] }
        }
      }
    });
    api.autosave.flush();
  })()`);
  const bomSavedRaw = await session3.eval(`window.__braAutoModeDebug.autosave.peek()`);
  assert(!!bomSavedRaw, 'BOM-only work did not produce an autosave record');
  const bomSaved = JSON.parse(bomSavedRaw);
  assert(bomSaved.snapshot.state.images.length === 0, 'BOM-only fixture unexpectedly populated Board images');
  assert(bomSaved.snapshot.state.bom.images.solid.length === 1, 'autosave lost the Solid Material Key image');
  assert(!!bomSaved.snapshot.state.bom.images.solid[0].dataURL, 'autosave lost the BOM bitmap bytes');

  await session3.eval(`window.location.reload()`);
  await sleep(400);
  await session3.close();
  const session4 = await openCdpSession(cdpPort);
  await session4.waitFor(`!!document.getElementById('autosaveRestoreBanner')`, 8000);
  await session4.eval(`Array.from(document.querySelectorAll('#autosaveRestoreBanner button')).find(b => /Restore/i.test(b.textContent)).click()`);
  await session4.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 1`, 6000);
  const bomRestored = await session4.eval(`(() => {
    const p = window.__braAutoModeDebug.exportProject();
    return { board: p.state.images.length, rows: p.state.bom.rows.length,
      description: p.state.bom.rows[0].cells.description,
      images: p.state.bom.images.solid.length,
      bitmap: !!p.state.bom.images.solid[0].dataURL };
  })()`);
  assert(bomRestored.board === 0, 'BOM autosave restore populated Board images');
  assert(bomRestored.rows === 1 && bomRestored.description === 'BOM-only edited material', 'BOM autosave restore lost table edits');
  assert(bomRestored.images === 1 && bomRestored.bitmap, 'BOM autosave restore lost Material Key image data');

  // Step 7 (US-092) — Board text notes are project data: they persist, they
  // undo, and they never leak into the measurement set. A note that reached
  // state.annotations would be bucketed by getLabelText() and rendered as an
  // extra POM row, then exported into the spec workbook — the exact corruption
  // this feature exists to remove — so "the spec row count did not move" is the
  // load-bearing assertion here, not a nicety.
  const noteSeed = await session4.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    // A project written BEFORE US-092: no notes key at all. It must open clean.
    await api.loadProject({
      format: 'bra-sketch-project', version: 1, savedAt: new Date().toISOString(),
      state: {
        annotations: [], images: [], eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'cm' }, nextSequence: 1, idCounter: 10,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0, styleId: '', pomSpecs: {},
        bom: { schemaVersion: 2, seedId: 'rsl-vdraft-1.0', rows: [], callouts: [], images: { solid: [], lace: [] } },
      },
    });
    const legacyNotes = api.getNotes().length;
    const rowsBefore = document.querySelectorAll('#specBody tr').length;
    const added = api.addNote('Lace edge must sit 2cm\\nbelow the cradle seam',
      { x: 140, y: 260 }, { color: 'blue', fontSize: 18, boxWidth: 190, leaders: [{ x: 300, y: 310 }] });
    api.autosave.flush();
    return {
      legacyNotes,
      rowsBefore,
      rowsAfter: document.querySelectorAll('#specBody tr').length,
      added,
      annotations: api.getAnnotations().length,
      exported: api.exportProject().state.notes,
      autosaved: JSON.parse(api.autosave.peek()).snapshot.state.notes,
    };
  })()`);
  assert(noteSeed.legacyNotes === 0, 'a pre-US-092 project file must open with no notes, got ' + noteSeed.legacyNotes);
  assert(noteSeed.added && Number.isFinite(noteSeed.added.id), 'addNote did not return a note record');
  assert(noteSeed.annotations === 0, 'a note leaked into state.annotations (' + noteSeed.annotations + ')');
  assert(noteSeed.rowsAfter === noteSeed.rowsBefore,
    `a note changed the Measurements panel: ${noteSeed.rowsBefore} rows -> ${noteSeed.rowsAfter}`);
  assert(Array.isArray(noteSeed.exported) && noteSeed.exported.length === 1,
    'the saved project did not carry the note');
  assert(noteSeed.exported[0].text === 'Lace edge must sit 2cm\nbelow the cradle seam',
    'the saved note lost its text (newline included): ' + JSON.stringify(noteSeed.exported[0].text));
  assert(noteSeed.exported[0].color === 'blue' && noteSeed.exported[0].fontSize === 18
    && noteSeed.exported[0].boxWidth === 190,
    'the saved note lost its styling: ' + JSON.stringify(noteSeed.exported[0]));
  assert(noteSeed.exported[0].leaders.length === 1
    && noteSeed.exported[0].leaders[0].x === 300 && noteSeed.exported[0].leaders[0].y === 310,
    'the saved note lost its leader: ' + JSON.stringify(noteSeed.exported[0].leaders));
  assert(Array.isArray(noteSeed.autosaved) && noteSeed.autosaved.length === 1,
    'autosave did not carry the note');

  // Undo/redo: adding a note is one history step.
  const noteHistory = await session4.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    const wait = () => new Promise(r => setTimeout(r, 120));
    document.getElementById('undoBtn').click();
    await wait();
    const afterUndo = api.getNotes().length;
    document.getElementById('redoBtn').click();
    await wait();
    const notes = api.getNotes();
    return { afterUndo, afterRedo: notes.length, text: notes[0] && notes[0].text,
      leaders: notes[0] && notes[0].leaders.length };
  })()`);
  assert(noteHistory.afterUndo === 0, 'Undo did not remove the note (' + noteHistory.afterUndo + ' left)');
  assert(noteHistory.afterRedo === 1, 'Redo did not restore the note');
  assert(noteHistory.text === 'Lace edge must sit 2cm\nbelow the cradle seam',
    'Redo restored the note without its text');
  assert(noteHistory.leaders === 1, 'Redo restored the note without its leader');

  // Reload -> Restore: the note comes back off the autosave slot.
  await session4.eval(`window.__braAutoModeDebug.autosave.flush()`);
  await session4.eval(`window.location.reload()`);
  await sleep(400);
  await session4.close();
  const session5 = await openCdpSession(cdpPort);
  await session5.waitFor(`!!document.getElementById('autosaveRestoreBanner')`, 8000);
  await session5.eval(`Array.from(document.querySelectorAll('#autosaveRestoreBanner button')).find(b => /Restore/i.test(b.textContent)).click()`);
  await session5.waitFor(`window.__braAutoModeDebug.getNotes().length === 1`, 6000);
  const noteRestored = await session5.eval(`(() => {
    const n = window.__braAutoModeDebug.getNotes()[0];
    return { text: n.text, color: n.color, fontSize: n.fontSize, leaders: n.leaders.length,
      annotations: window.__braAutoModeDebug.getAnnotations().length };
  })()`);
  assert(noteRestored.text === 'Lace edge must sit 2cm\nbelow the cradle seam',
    'the restored note lost its text');
  assert(noteRestored.color === 'blue' && noteRestored.fontSize === 18, 'the restored note lost its styling');
  assert(noteRestored.leaders === 1, 'the restored note lost its leader');
  assert(noteRestored.annotations === 0, 'restore put the note into state.annotations');

  await session5.close();
  console.log('PASS  autosave-check');
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL  ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

async function openCdpSession(port) {
  // Poll until Chrome exposes a page target after reload.
  let targets;
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const t = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return connectToTarget(t.webSocketDebuggerUrl);
    } catch (_) {}
    await sleep(80);
  }
  throw new Error('no page target available on CDP port ' + port);
}

async function connectToTarget(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const cdp = (method, params) => new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  const evalJs = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval failed');
    return res.result.value;
  };
  const waitFor = async (expression, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await evalJs(expression)) return; } catch (_) {}
      await sleep(80);
    }
    throw new Error('waitFor timeout: ' + expression);
  };
  return { eval: evalJs, waitFor, close: () => ws.close() };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForCdp(port) {
  for (let i = 0; i < 80; i += 1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch (_) {}
    await sleep(80);
  }
  throw new Error('CDP did not come up');
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
  return await res.json();
}

try {
  await main();
} catch (err) {
  if (process.exitCode == null) process.exitCode = 1;
  if (err && err.message) console.error('FAIL', err.message);
} finally {
  for (const task of cleanupTasks.reverse()) {
    try { await task(); } catch (_) {}
  }
}
