#!/usr/bin/env node
// End-to-end verification of the MAIN PAGE sheet (US-068, ADR 0037; now a
// tech-pack page switched via the toolbar's tab bar, US-069, ADR 0038).
// Boots the app in headless Chrome and drives the sheet through the DOM the
// way a TD would: switch to it, pick a suggested value, undo it, add an
// off-list value, add and remove a colourway, then round-trip the project
// file.
//
// The two cases that justify a dedicated suite rather than a unit test:
//   - a pre-US-068 project file (no mainPage key at all) must still open;
//   - the suggestion rosters must never behave as a wall — an off-list value
//     has to persist in fieldExtra.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let server, chrome, userDataDir;
const cleanupTasks = [];
let passed = 0;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise((r) => server.close(r)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'mainpage-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));

  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `${started.baseUrl}/index.html?smoke=${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise((r) => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`document.querySelectorAll('#specBody tr').length > 0`, 8000);

  // --- 1. The tab switches pages and renders the shipped roster -----------
  await s.eval(`document.querySelector('#pageTabBar [data-page="mainpage"]').click()`);
  await s.waitFor(`document.body.classList.contains('mainpage-open')`, 4000);

  const shape = await s.eval(`({
    pageHidden: document.getElementById('mainPageOverlay').classList.contains('page-hidden'),
    boardHidden: document.getElementById('boardToolbarGroups').classList.contains('page-hidden'),
    activePage: window.__braAutoModeDebug.getState().activePage,
    fieldRows: document.querySelectorAll('#mp-fields th[data-i]').length,
    breakdownHeads: Array.from(document.querySelectorAll('#mp-fields .mp-bdhead span'))
      .map(el => el.textContent.trim()).join('|'),
    breakdownCells: document.querySelectorAll('#mp-fields .mp-bd-sub[data-f="part"]').length,
    blockRef: Array.from(document.querySelectorAll('#mp-fields th[data-i]'))
      .some(th => /Block Reference/i.test(th.textContent)),
    sketchSlots: document.querySelectorAll('#mainPageOverlay .mp-sketch[data-mp-sk]').length,
    sketchTags: Array.from(document.querySelectorAll('#mainPageOverlay .mp-sketch[data-mp-sk]'))
      .map(el => el.dataset.mpSk).join(','),
    cwTables: document.querySelectorAll('table.mp-cwx').length,
    cwRows: document.querySelectorAll('table.mp-cwx')[0].querySelectorAll('tr').length,
    brand: document.querySelector('#mp-fields td[data-i="0"][data-f="value"]').textContent.trim(),
    triggers: document.querySelectorAll('#mp-fields button.mp-dd').length,
  })`);
  check(shape.pageHidden === false, 'sheet stayed hidden after switching tabs');
  check(shape.boardHidden === true, 'Board toolbar groups should hide when MAIN PAGE is active');
  check(shape.activePage === 'mainpage', `state.activePage should be 'mainpage', got ${shape.activePage}`);
  check(shape.fieldRows === 14, `expected 14 field rows, got ${shape.fieldRows}`);
  // US-080: the breakdown row prints as three captioned sub-cells.
  check(shape.breakdownHeads === 'style prefix|category #:|range no:',
    `breakdown sub-headers wrong: ${shape.breakdownHeads}`);
  check(shape.breakdownCells === 3, `expected 3 breakdown sub-cells, got ${shape.breakdownCells}`);
  check(shape.blockRef, 'Block Reference - 原版品 row is missing from the roster');
  check(shape.sketchSlots === 4, `expected 4 version sketch slots, got ${shape.sketchSlots}`);
  check(shape.sketchTags === 'lace:0,lace:1,solid:0,solid:1',
    `sketch slots are in the wrong order: ${shape.sketchTags}`);
  check(shape.cwTables === 2, `expected a colorway table per version panel, got ${shape.cwTables}`);
  check(shape.cwRows === 2, `expected 2 seeded colorways, got ${shape.cwRows}`);
  check(shape.brand === 'Crossian', `Brand should be fixed to Crossian, got "${shape.brand}"`);
  // 11 specs in MAIN_FIELD_SPEC; Brand and the creation date have no picker.
  check(shape.triggers === 11, `expected 11 suggestion triggers, got ${shape.triggers}`);

  // --- 2. A suggested value applies to the right row ----------------------
  /* Read off data-i, not the tr index: US-080's breakdown caption row means a
     DOM row index is no longer the field index. */
  const techDesRow = await s.eval(`(() => {
    const th = Array.from(document.querySelectorAll('#mp-fields th[data-i]'))
      .find(el => /Technical Designer/i.test(el.textContent));
    return th ? +th.dataset.i : -1;
  })()`);
  check(techDesRow > -1, 'no Technical Designer row rendered');

  await s.eval(`document.querySelector('#mp-fields button[data-mp-dd="${techDesRow}"]').click()`);
  await s.waitFor(`document.getElementById('mp-menu').classList.contains('open')`, 3000);
  const picked = await s.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('#mp-menu .mm-list button'))
      .find(b => b.textContent.includes('Tuyen Van Bui'));
    if (!btn) return null;
    btn.click();
    return window.__braAutoModeDebug.exportProject().state.mainPage.fields[${techDesRow}].value;
  })()`);
  check(picked === 'Tuyen Van Bui', `picking a suggestion did not write the field, got ${JSON.stringify(picked)}`);

  // --- 3. Undo covers a MAIN PAGE edit ------------------------------------
  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`
    window.__braAutoModeDebug.exportProject().state.mainPage.fields[${techDesRow}].value !== 'Tuyen Van Bui'
  `, 4000);
  const afterUndo = await s.eval(`
    document.querySelector('#mp-fields td[data-i="${techDesRow}"][data-f="value"]').textContent.trim()
  `);
  check(afterUndo === 'TBC', `undo should restore the seeded value, cell now reads "${afterUndo}"`);

  // --- 4. A roster is a suggestion, not a wall ----------------------------
  await s.eval(`document.querySelector('#mp-fields button[data-mp-dd="${techDesRow}"]').click()`);
  await s.waitFor(`document.getElementById('mp-menu').classList.contains('open')`, 3000);
  const offList = await s.eval(`(() => {
    const q = document.querySelector('#mp-menu .mm-q');
    q.value = 'Nguyen Van Test';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const free = document.querySelector('#mp-menu [data-mp-free]');
    if (!free) return { ok: false, reason: 'no off-list row offered' };
    free.click();
    const mp = window.__braAutoModeDebug.exportProject().state.mainPage;
    return { ok: true, value: mp.fields[${techDesRow}].value, extra: mp.fieldExtra.techDes || [] };
  })()`);
  check(offList.ok, 'off-list add: ' + (offList.reason || ''));
  check(offList.value === 'Nguyen Van Test', `off-list value not written, got ${JSON.stringify(offList.value)}`);
  check(offList.extra.includes('Nguyen Van Test'), 'off-list value was not remembered in fieldExtra');

  // --- 5. Diacritic-folded search finds a Vietnamese roster entry ---------
  await s.eval(`document.querySelector('#mp-fields button[data-mp-dd="${techDesRow}"]').click()`);
  await s.waitFor(`document.getElementById('mp-menu').classList.contains('open')`, 3000);
  const folded = await s.eval(`(() => {
    const q = document.querySelector('#mp-menu .mm-q');
    q.value = 'nga hoang';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return Array.from(document.querySelectorAll('#mp-menu .mm-list [data-mp-opt] .mm-name'))
      .map(n => n.textContent);
  })()`);
  check(folded.includes('Nga Hang Thi Hoang'),
    `token search should reorder name parts, got ${JSON.stringify(folded)}`);
  await s.eval(`document.querySelector('#mp-menu [data-mp-clear]').click()`);

  // --- 6. Colour picker adds from the master list, then renumbers ---------
  await s.eval(`document.getElementById('mainPageAddColorBtn').click()`);
  await s.waitFor(`document.querySelector('.color-add-wrap').classList.contains('open')`, 3000);
  const added = await s.eval(`(() => {
    const q = document.querySelector('.color-menu .cm-q');
    q.value = '14-38 lilac';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    const first = document.querySelector('.color-menu .cm-list button');
    if (!first) return { ok: false, reason: 'token search found no colour' };
    first.click();
    return { ok: true, colorways: window.__braAutoModeDebug.exportProject().state.mainPage.colorways };
  })()`);
  check(added.ok, 'colour add: ' + (added.reason || ''));
  check(added.colorways.length === 3, `expected 3 colorways, got ${added.colorways.length}`);
  check(added.colorways[2].value === '14-3812 TCX Lilac Mist',
    `token search picked the wrong colour: ${added.colorways[2].value}`);
  check(added.colorways[2].hex === '#cbbdd8', `shade cue lost, got ${added.colorways[2].hex}`);

  const mirrored = await s.eval(`
    Array.from(document.querySelectorAll('table.mp-cwx')).map(t => t.querySelectorAll('tr').length)
  `);
  check(mirrored.every(n => n === 3), `both version panels must show the same list, got ${JSON.stringify(mirrored)}`);

  const removed = await s.eval(`(() => {
    document.querySelector('table.mp-cwx [data-rm="0"]').click();
    return window.__braAutoModeDebug.exportProject().state.mainPage.colorways;
  })()`);
  check(removed.length === 2, `remove should leave 2 colorways, got ${removed.length}`);
  check(removed[0].col === 'COL 1' && removed[1].col === 'COL 2',
    `COL numbers were not rebuilt: ${JSON.stringify(removed.map(c => c.col))}`);

  // --- 7. A pre-US-068 project still opens, and seeds a default ----------
  const legacy = await s.eval(`(async () => {
    await window.__braAutoModeDebug.loadProject({
      format: 'bra-sketch-project',
      version: 1,
      savedAt: new Date().toISOString(),
      state: {
        annotations: [], images: [], eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'cm' },
        nextSequence: 1, idCounter: 1,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0, styleId: '', pomSpecs: {},
      },
    });
    const mp = window.__braAutoModeDebug.exportProject().state.mainPage;
    return { fields: mp.fields.length, colorways: mp.colorways.length, libId: mp.colorLibId,
             lib: mp.colorLibrary.length };
  })()`);
  check(legacy.fields === 14, `a pre-US-068 project should seed 14 fields, got ${legacy.fields}`);
  check(legacy.colorways === 2, `should seed 2 colorways, got ${legacy.colorways}`);
  check(legacy.libId === 'color-master-list-47', `colorLibId wrong: ${legacy.libId}`);
  check(legacy.lib === 47, `Color Master List should carry 47 entries, got ${legacy.lib}`);

  // --- 8. A saved MAIN PAGE survives the round-trip ----------------------
  const roundTrip = await s.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    api.exportProject();
    const before = api.exportProject();
    before.state.mainPage.fields[${techDesRow}].value = 'Round Trip TD';
    before.state.mainPage.colorways.push({ col: 'COL 3', value: 'Zenchic Pink', hex: '#e9b7bd' });
    await api.loadProject(before);
    const after = api.exportProject().state.mainPage;
    return { value: after.fields[${techDesRow}].value, colorways: after.colorways.length,
             rendered: document.querySelector('#mp-fields td[data-i="${techDesRow}"][data-f="value"]').textContent.trim() };
  })()`);
  check(roundTrip.value === 'Round Trip TD', `save/open lost the field value: ${roundTrip.value}`);
  check(roundTrip.colorways === 3, `save/open lost a colorway, got ${roundTrip.colorways}`);
  check(roundTrip.rendered === 'Round Trip TD', `open did not repaint the sheet, cell reads "${roundTrip.rendered}"`);

  // --- 9. MAIN PAGE is metadata: it adds no POM, anchor or view ----------
  const untouched = await s.eval(`(() => {
    const st = window.__braAutoModeDebug.getState();
    const mp = window.__braAutoModeDebug.exportProject().state.mainPage;
    return { anchors: st.anchorCount, drafts: st.draftCount,
             keys: Object.keys(mp).sort().join(',') };
  })()`);
  check(untouched.anchors === 0 && untouched.drafts === 0,
    'MAIN PAGE must not create anchors or drafts');
  check(untouched.keys === 'colorLibId,colorLibrary,colorways,fieldExtra,fields,provenance,sketches',
    `unexpected mainPage shape: ${untouched.keys}`);

  // --- 10. Breakdown sub-cells drive the composite value -----------------
  const bdRow = await s.eval(`(() => {
    const th = Array.from(document.querySelectorAll('#mp-fields th[data-i]'))
      .find(el => /Style No Breakdown/i.test(el.textContent));
    return th ? +th.dataset.i : -1;
  })()`);
  check(bdRow > -1, 'no Style No Breakdown row rendered');

  const breakdown = await s.eval(`(() => {
    const set = (part, text) => {
      const cell = document.querySelector('#mp-fields [data-i="${bdRow}"][data-part="' + part + '"]');
      cell.textContent = text;
      cell.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('prefix', 'LiftyBliss');
    set('rangeNo', '3');
    const f = window.__braAutoModeDebug.exportProject().state.mainPage.fields[${bdRow}];
    return { parts: f.parts, value: f.value };
  })()`);
  check(breakdown.parts.prefix === 'LiftyBliss' && breakdown.parts.rangeNo === '3',
    `breakdown parts not stored: ${JSON.stringify(breakdown.parts)}`);
  // Empty parts drop out of the composite rather than leaving " ·  · ".
  check(breakdown.value === 'LiftyBliss · 3',
    `composite value should be derived from the parts, got "${breakdown.value}"`);

  // The picker writes the prefix sub-cell, never the whole composite.
  await s.eval(`document.querySelector('#mp-fields button[data-mp-dd="${bdRow}"]').click()`);
  await s.waitFor(`document.getElementById('mp-menu').classList.contains('open')`, 3000);
  const bdPick = await s.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('#mp-menu .mm-list button'))
      .find(b => b.textContent.includes('KiraForm'));
    if (!btn) return null;
    btn.click();
    const f = window.__braAutoModeDebug.exportProject().state.mainPage.fields[${bdRow}];
    return { parts: f.parts, value: f.value };
  })()`);
  check(bdPick && bdPick.parts.prefix === 'KiraForm',
    `the range-name picker should write the prefix, got ${JSON.stringify(bdPick)}`);
  check(bdPick.parts.rangeNo === '3' && bdPick.value === 'KiraForm · 3',
    `picking a prefix must not clear the other sub-cells: ${JSON.stringify(bdPick)}`);

  // --- 11. A version sketch round-trips without bloating history ----------
  const sketch = await s.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    // 2x1 red PNG — the smallest thing with a non-1 aspect ratio.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';
    const rawState = await api.setMainPageSketch('lace', 0, png);
    const saved = api.exportProject().state.mainPage.sketches;
    const live = api.exportProject();
    await api.loadProject(live);
    const after = api.exportProject().state.mainPage.sketches;
    return {
      slot: saved.lace[0] && { hasId: !!saved.lace[0].id, aspect: saved.lace[0].aspect,
                               bytes: !!saved.lace[0].dataURL },
      historyClean: String(rawState).indexOf('data:image') === -1,
      afterOpen: !!(after.lace[0] && after.lace[0].dataURL),
      rendered: !!document.querySelector('.mp-sketch[data-mp-sk="lace:0"] img'),
      others: [after.lace[1], after.solid[0], after.solid[1]].every(v => v === null),
    };
  })()`);
  check(sketch.slot && sketch.slot.hasId, 'setting a sketch did not create a slot record');
  check(Math.abs(sketch.slot.aspect - 2) < 0.01,
    `slot aspect should be measured from the image, got ${sketch.slot.aspect}`);
  check(sketch.slot.bytes, 'save did not inject the sketch bytes');
  check(sketch.historyClean, 'image bytes leaked into the history-cloned mainPage state');
  check(sketch.afterOpen, 'open lost the sketch bytes');
  check(sketch.rendered, 'the slot did not repaint with the image');
  check(sketch.others, 'setting one slot disturbed the other three');

  const cleared = await s.eval(`(() => {
    document.querySelector('[data-mp-sk-clear="lace:0"]').click();
    return window.__braAutoModeDebug.exportProject().state.mainPage.sketches.lace[0];
  })()`);
  check(cleared === null, `clearing a slot should empty it, got ${JSON.stringify(cleared)}`);

  // Undo restores the slot AND still finds its bytes in the module map.
  await s.eval(`document.getElementById('undoBtn').click()`);
  const undone = await s.eval(`(() => {
    const slot = window.__braAutoModeDebug.exportProject().state.mainPage.sketches.lace[0];
    return { hasSlot: !!(slot && slot.id), bytes: !!(slot && slot.dataURL) };
  })()`);
  check(undone.hasSlot && undone.bytes,
    `undo should restore the sketch and its bytes, got ${JSON.stringify(undone)}`);

  await s.close();
  console.log(`PASS  mainpage-check   ${passed}/${passed} assertions ok`);
}

function check(cond, msg) {
  if (!cond) {
    console.error('FAIL  ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  passed += 1;
}

async function openCdpSession(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
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
