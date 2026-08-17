#!/usr/bin/env node
// End-to-end verification of the Preview & Export page (US-079, ADR 0046; a
// tech-pack page switched via the toolbar's tab bar, same harness pattern as
// bom-check.mjs / mainpage-check.mjs / construction-check.mjs).
//
// Boots the app in headless Chrome, switches to Preview & Export, asserts the
// six A4 sheets render in contract order with per-page orientation and live
// content, toggles a sheet checkbox (with undo), then exercises the tech-pack
// workbook: determinism, sheet order, the POM sheet's byte-identity with the
// Board "Export Excel" builder, subset export, BOM scope filtering, embedded
// images, external `unzip -t` (+ openpyxl when available), and the project
// round-trip of state.preview including the legacy all-enabled default.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const FROZEN = '2026-01-05T10:00:00.000Z';
const ORDER = ['mainpage', 'construction-solid', 'construction-lace', 'bom-solid', 'bom-lace', 'pom'];
const SHEET_NAMES = ['MAIN PAGE', 'CONSTRUCTION-SOLID', 'CONSTRUCTION-LACE', 'BOM-SOLID', 'BOM-LACE', 'Measurement Spec'];

let server, chrome, userDataDir;
const cleanupTasks = [];
let passed = 0;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise((r) => server.close(r)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'preview-check-'));
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

  // --- 1. Tab bar has the fifth tab; switching shows the page and the six
  //     sheets in contract order with per-page orientation. -----------------
  const tabShape = await s.eval(`({
    tabCount: document.querySelectorAll('#pageTabBar [data-page]').length,
    label: (document.querySelector('#pageTabBar [data-page="preview"]') || {}).textContent || '',
  })`);
  check(tabShape.tabCount === 5, `expected 5 page tabs, got ${tabShape.tabCount}`);
  check(tabShape.label.trim() === 'Preview & Export', `unexpected tab label: ${tabShape.label}`);

  await s.eval(`document.querySelector('#pageTabBar [data-page="preview"]').click()`);
  await s.waitFor(`document.body.classList.contains('preview-open')`, 4000);
  const pageShape = await s.eval(`({
    pageHidden: document.getElementById('previewPage').classList.contains('page-hidden'),
    boardHidden: document.getElementById('boardToolbarGroups').classList.contains('page-hidden'),
    activePage: window.__braAutoModeDebug.getState().activePage,
    keys: Array.from(document.querySelectorAll('#pvSheets .pv-sheet')).map(x => x.dataset.pvSheet).join(','),
    orients: Array.from(document.querySelectorAll('#pvSheets .pv-paper')).map(x =>
      x.classList.contains('pv-portrait') ? 'p' : (x.classList.contains('pv-landscape') ? 'l' : '?')).join(''),
    checked: document.querySelectorAll('#pvSheets [data-pv-toggle]:checked').length,
    btn: document.getElementById('pvExportXlsxBtn').textContent,
    btnDisabled: document.getElementById('pvExportXlsxBtn').disabled,
  })`);
  check(pageShape.pageHidden === false, 'preview page stayed hidden after switching tabs');
  check(pageShape.boardHidden === true, 'Board toolbar groups should hide when Preview is active');
  check(pageShape.activePage === 'preview', `state.activePage should be 'preview', got ${pageShape.activePage}`);
  check(pageShape.keys === ORDER.join(','), `sheet order mismatch: ${pageShape.keys}`);
  check(pageShape.orients === 'pllppl', `per-page orientation mismatch: ${pageShape.orients}`);
  check(pageShape.checked === 6, `all 6 sheets should start enabled, got ${pageShape.checked}`);
  check(pageShape.btn.includes('6/6'), `export button should say 6/6, got: ${pageShape.btn}`);
  check(pageShape.btnDisabled === false, 'export button should be enabled with sheets ticked');

  // --- 2. Each paper carries live content from its page's state. ----------
  const content = await s.eval(`({
    /* US-080: the breakdown row adds a caption row of its own, so count the
       label cells, not every <tr>. */
    mpFieldRows: document.querySelectorAll('[data-pv-paper="mainpage"] .mp-kv tr th:not(.mp-bd-blank)').length,
    mpStateFields: window.__braAutoModeDebug.exportProject().state.mainPage.fields.length,
    mpCwTables: document.querySelectorAll('[data-pv-paper="mainpage"] .mp-cwx').length,
    mpBdCells: document.querySelectorAll('[data-pv-paper="mainpage"] .mp-bd-sub').length,
    mpSketchSlots: document.querySelectorAll('[data-pv-paper="mainpage"] .mp-sketch').length,
    ccSolidCanvas: (document.querySelector('[data-pv-paper="construction-solid"] canvas') || {}).width || 0,
    ccLaceCanvas: (document.querySelector('[data-pv-paper="construction-lace"] canvas') || {}).width || 0,
    bomSolidBands: document.querySelectorAll('[data-pv-paper="bom-solid"] .bm-secband').length,
    bomLaceBands: document.querySelectorAll('[data-pv-paper="bom-lace"] .bm-secband').length,
    bomSeedRow: (document.querySelector('[data-pv-paper="bom-solid"] .bm-sheet') || {}).textContent || '',
    pomEmpty: !!document.querySelector('[data-pv-paper="pom"] .pv-empty'),
    pomSpecRows: document.querySelectorAll('[data-pv-paper="pom"] .pv-spec tbody tr').length,
  })`);
  check(content.mpFieldRows === content.mpStateFields,
    `MAIN PAGE preview rows (${content.mpFieldRows}) must match state fields (${content.mpStateFields})`);
  check(content.mpCwTables === 2, 'MAIN PAGE preview should show Lace + Solid colorway panels');
  check(content.mpBdCells === 3, `MAIN PAGE preview should split the breakdown into 3 sub-cells, got ${content.mpBdCells}`);
  check(content.mpSketchSlots === 4, `MAIN PAGE preview should show 4 sketch slots, got ${content.mpSketchSlots}`);
  check(content.ccSolidCanvas > 0 && content.ccLaceCanvas > 0, 'Construction sheets must render canvases');
  check(content.bomSolidBands === 2 && content.bomLaceBands === 2, 'BOM sheets must show FABRIC + TRIM bands');
  check(content.bomSeedRow.includes('Shell fabric'), 'BOM-SOLID preview must carry the seeded rows');
  check(content.pomEmpty, 'empty board should show the POM sheet placeholder');
  check(content.pomSpecRows === 18, `POM spec table should list 18 POMs, got ${content.pomSpecRows}`);

  // --- 3. Checkbox toggling: pv-off class, state, button label; undoable. --
  await s.eval(`document.querySelector('[data-pv-toggle="construction-lace"]').click()`);
  const toggled = await s.eval(`({
    off: document.querySelector('[data-pv-sheet="construction-lace"]').classList.contains('pv-off'),
    state: window.__braAutoModeDebug.exportProject().state.preview.enabledPages['construction-lace'],
    btn: document.getElementById('pvExportXlsxBtn').textContent,
  })`);
  check(toggled.off === true, 'unticked sheet should dim via pv-off');
  check(toggled.state === false, 'untick must persist into state.preview.enabledPages');
  check(toggled.btn.includes('5/6'), `export button should say 5/6, got: ${toggled.btn}`);

  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.preview.enabledPages['construction-lace'] === true`, 4000);
  const undone = await s.eval(`({
    checked: document.querySelector('[data-pv-toggle="construction-lace"]').checked,
    off: document.querySelector('[data-pv-sheet="construction-lace"]').classList.contains('pv-off'),
  })`);
  check(undone.checked === true && undone.off === false, 'undo must restore the sheet checkbox and preview');

  // --- 4. Tech-pack workbook: determinism, sheet order, POM byte-identity
  //     with the Board Export Excel builder, subset export. -----------------
  const b64a = await s.eval(`window.__braAutoModeDebug.exportTechPackXlsxBase64('${FROZEN}')`);
  const b64b = await s.eval(`window.__braAutoModeDebug.exportTechPackXlsxBase64('${FROZEN}')`);
  check(typeof b64a === 'string' && b64a.length > 0, 'tech-pack export returned no bytes');
  check(b64a === b64b, 'tech-pack export must be deterministic for a frozen date');

  const buf = Buffer.from(b64a, 'base64');
  const entries = unzipStore(buf);
  for (let i = 1; i <= 6; i += 1) {
    check(!!entries[`xl/worksheets/sheet${i}.xml`], `workbook missing sheet${i}.xml`);
  }
  const workbookXml = entries['xl/workbook.xml'].toString('utf-8');
  const nameOrder = [...workbookXml.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  check(JSON.stringify(nameOrder) === JSON.stringify(SHEET_NAMES),
    `sheet name order mismatch: ${nameOrder.join(' | ')}`);

  const singleB64 = await s.eval(
    `window.__braAutoModeDebug.exportSpecXlsxBase64('${FROZEN}', { image: false })`);
  const singleSheet = unzipStore(Buffer.from(singleB64, 'base64'))['xl/worksheets/sheet1.xml'].toString('utf-8');
  const packPomSheet = entries['xl/worksheets/sheet6.xml'].toString('utf-8');
  check(packPomSheet === singleSheet,
    'tech-pack POM sheet must be byte-identical to the Board Export Excel sheet (one builder)');

  const ccPng = entries['xl/media/image1.png'];
  check(!!ccPng && ccPng.readUInt32BE(0) === 0x89504e47, 'Construction sheet must embed a PNG image');
  check(!!entries['xl/drawings/drawing2.xml'] && !!entries['xl/drawings/drawing3.xml'],
    'both Construction sheets need drawing parts');
  check(!entries['xl/drawings/drawing1.xml'],
    'MAIN PAGE with no version sketches must stay a cell sheet with no drawing');
  const mainSheet = entries['xl/worksheets/sheet1.xml'].toString('utf-8');
  check(mainSheet.includes('COLORWAYS') && mainSheet.includes('MAIN PAGE'), 'MAIN PAGE sheet must carry field/colorway cells');
  // US-080: the breakdown's three parts and Block Reference reach the sheet.
  check(mainSheet.includes('style prefix') && mainSheet.includes('category #:')
    && mainSheet.includes('range no:'),
    'MAIN PAGE sheet must carry the three Style No Breakdown sub-rows');
  check(mainSheet.includes('Block Reference'), 'MAIN PAGE sheet must carry the Block Reference row');
  const bomSolidSheet = entries['xl/worksheets/sheet4.xml'].toString('utf-8');
  check(bomSolidSheet.includes('Shell fabric') && bomSolidSheet.includes('MAIN BODY FABRICS'),
    'BOM-SOLID sheet must carry the seeded table as cells');

  const subsetB64 = await s.eval(`window.__braAutoModeDebug.exportTechPackXlsxBase64('${FROZEN}',
    { enabledPages: { 'construction-lace': false, 'bom-lace': false } })`);
  const subsetWb = unzipStore(Buffer.from(subsetB64, 'base64'))['xl/workbook.xml'].toString('utf-8');
  const subsetNames = [...subsetWb.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  check(JSON.stringify(subsetNames) === JSON.stringify(['MAIN PAGE', 'CONSTRUCTION-SOLID', 'BOM-SOLID', 'Measurement Spec']),
    `subset export sheets mismatch: ${subsetNames.join(' | ')}`);
  const afterSubset = await s.eval(
    `window.__braAutoModeDebug.exportProject().state.preview.enabledPages['construction-lace']`);
  check(afterSubset === true, 'test-hook enabledPages override must not leak into state');

  // --- 5. BOM scope filtering: a LACE row leaves BOM-SOLID and appears in
  //     BOM-LACE (BOTH rows live on both sheets). ---------------------------
  await s.eval(`document.querySelector('#pageTabBar [data-page="bom"]').click()`);
  await s.waitFor(`document.body.classList.contains('bom-open')`, 4000);
  await s.eval(`(() => {
    const sel = document.querySelector('#bomSections select[data-scope]');
    sel.value = 'LACE';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.rows.some(r => r.scope === 'LACE')`, 4000);
  const scopedDesc = await s.eval(`window.__braAutoModeDebug.exportProject().state.bom.rows.find(r => r.scope === 'LACE').cells.description`);
  const scopedB64 = await s.eval(`window.__braAutoModeDebug.exportTechPackXlsxBase64('${FROZEN}')`);
  const scopedEntries = unzipStore(Buffer.from(scopedB64, 'base64'));
  const scopedSolid = scopedEntries['xl/worksheets/sheet4.xml'].toString('utf-8');
  const scopedLace = scopedEntries['xl/worksheets/sheet5.xml'].toString('utf-8');
  check(!scopedSolid.includes(scopedDesc), `LACE-scoped row "${scopedDesc}" must leave BOM-SOLID`);
  check(scopedLace.includes(scopedDesc), `LACE-scoped row "${scopedDesc}" must appear in BOM-LACE`);
  check(scopedSolid.includes('TRIMS / COMPONENTS'), 'BOTH rows must keep BOM-SOLID populated');

  // --- 6. A Material Key image embeds into the BOM sheet as a PNG. ---------
  await s.eval(`(async () => {
    document.querySelector('[data-bom-variant="solid"]').click();
    const blob = await (await fetch('${TINY_PNG}')).blob();
    const file = new File([blob], 'pasted.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => file }] } });
    document.getElementById('bomMatkeyCanvas').dispatchEvent(event);
    return true;
  })()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 1`, 4000);
  const matkeyB64 = await s.eval(`window.__braAutoModeDebug.exportTechPackXlsxBase64('${FROZEN}')`);
  const matkeyEntries = unzipStore(Buffer.from(matkeyB64, 'base64'));
  check(!!matkeyEntries['xl/drawings/drawing4.xml'], 'BOM-SOLID with a Material Key must gain a drawing part');
  const matkeySheet = matkeyEntries['xl/worksheets/sheet4.xml'].toString('utf-8');
  check(matkeySheet.includes('MATERIAL KEY'), 'BOM-SOLID sheet must label the embedded Material Key');
  check(matkeySheet.indexOf('MATERIAL KEY') < matkeySheet.indexOf('MAIN BODY FABRICS'),
    'Material Key must sit ABOVE the BOM table, matching the page and preview order');

  // --- 7. External validators on the full workbook. ------------------------
  const xlsxPath = path.join(userDataDir, 'techpack.xlsx');
  await writeFile(xlsxPath, Buffer.from(matkeyB64, 'base64'));
  const unzipRes = spawnSync('unzip', ['-t', xlsxPath], { encoding: 'utf-8' });
  check(unzipRes.status === 0, `unzip -t rejected the workbook: ${unzipRes.stdout} ${unzipRes.stderr}`);
  const py = spawnSync('python3', ['-c',
    'import sys, openpyxl; wb = openpyxl.load_workbook(sys.argv[1]); print("|".join(wb.sheetnames))',
    xlsxPath], { encoding: 'utf-8' });
  if (py.status === 0) {
    check(py.stdout.trim() === SHEET_NAMES.join('|'), `openpyxl sheet names mismatch: ${py.stdout.trim()}`);
  } else {
    console.log('note: python3/openpyxl unavailable — external reader check skipped');
  }

  // --- 7b. A version sketch reaches the preview sheet and the worksheet. ---
  await s.eval(`document.querySelector('#pageTabBar [data-page="preview"]').click()`);
  await s.waitFor(`document.body.classList.contains('preview-open')`, 4000);
  // Setting a slot while the preview is in view must repaint it, no tab dance.
  await s.eval(`window.__braAutoModeDebug.setMainPageSketch('lace', 0, '${TINY_PNG}')`);
  const sketchPreview = await s.eval(
    `document.querySelectorAll('[data-pv-paper="mainpage"] .mp-sketch img').length`);
  check(sketchPreview === 1, `the preview MAIN PAGE sheet should show the pasted flat, got ${sketchPreview}`);

  const skB64 = await s.eval(`window.__braAutoModeDebug.exportTechPackXlsxBase64('${FROZEN}')`);
  const skEntries = unzipStore(Buffer.from(skB64, 'base64'));
  check(!!skEntries['xl/drawings/drawing1.xml'],
    'MAIN PAGE with a version sketch must gain a drawing part');
  const skMain = skEntries['xl/worksheets/sheet1.xml'].toString('utf-8');
  check(skMain.includes('LACE VERSION') && skMain.includes('FRONT'),
    'MAIN PAGE sheet must band the sketch block and label the slot');
  check(!skMain.includes('SOLID VERSION'),
    'a version with no sketch must not print an empty band');

  // --- 8. Project round-trip: saved ticks reopen as saved; a legacy project
  //     without state.preview defaults to all-enabled. ----------------------
  const roundTrip = await s.eval(`(async () => {
    const saved = window.__braAutoModeDebug.exportProject();
    saved.state.preview = { enabledPages: { 'construction-lace': false } };
    await window.__braAutoModeDebug.loadProject(saved);
    const reopened = window.__braAutoModeDebug.exportProject().state.preview.enabledPages;
    const legacy = window.__braAutoModeDebug.exportProject();
    delete legacy.state.preview;
    await window.__braAutoModeDebug.loadProject(legacy);
    const defaulted = window.__braAutoModeDebug.exportProject().state.preview.enabledPages;
    return { reopened, defaulted };
  })()`);
  check(roundTrip.reopened['construction-lace'] === false,
    'saved untick must survive the project round-trip');
  check(roundTrip.reopened['mainpage'] === true && roundTrip.reopened['pom'] === true,
    'sheets missing from a saved preview block must default to enabled');
  check(Object.keys(roundTrip.defaulted).length === 6
    && Object.values(roundTrip.defaulted).every(v => v === true),
    'a legacy project without state.preview must open with all 6 sheets enabled');

  await s.close();
  console.log(`PASS  preview-check   ${passed}/${passed} assertions ok`);
}

function check(cond, msg) {
  if (!cond) {
    console.error('FAIL  ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  passed += 1;
}

// ---- minimal STORE-method unzip (read side of zipStore, as in export-xlsx-tests) ----

function unzipStore(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD — not a ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    if (method !== 0) throw new Error('expected STORE method for ' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    entries[name] = buf.subarray(start, start + compSize);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---- CDP plumbing (mirrors scripts/bom-check.mjs) ----

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
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      const detail = (ex && (ex.description || ex.value)) || JSON.stringify(res.exceptionDetails);
      throw new Error(detail);
    }
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
