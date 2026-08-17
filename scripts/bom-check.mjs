#!/usr/bin/env node
// End-to-end verification of the BOM page (US-072, ADR 0041; a tech-pack
// page switched via the toolbar's tab bar, same pattern as MAIN PAGE's
// mainpage-check.mjs and Construction's construction-check.mjs).
//
// Boots the app in headless Chrome, pastes a sketch image onto the Board,
// switches to BOM, adds/removes FABRIC and TRIM rows, changes a row's scope
// and confirms the Solid/Lace filter follows it, asserts colorway columns
// render from state.mainPage.colorways with an independently-editable
// override, fills a row from the material quick-list and confirms it never
// overwrites a cell the TD already typed into, places a material-key
// callout on the sketch, drags it, adds and removes a second leader line,
// deletes it, and round-trips a project file that carries state.bom.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A well-known 1x1 transparent PNG, enough for an <img> to decode and for
// image bounds math (rendered at 400x300 via the callout's imageRec.width/height).
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let server, chrome, userDataDir;
const cleanupTasks = [];
let passed = 0;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise((r) => server.close(r)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bom-check-'));
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

  // --- 1. An empty board still opens a self-contained BOM Solid sheet:
  //     Material Key is always above its table; there are no view tabs. ----
  await s.eval(`document.querySelector('#pageTabBar [data-page="bom"]').click()`);
  await s.waitFor(`document.body.classList.contains('bom-open')`, 4000);
  const emptyShape = await s.eval(`({
    pageHidden: document.getElementById('bomPage').classList.contains('page-hidden'),
    boardHidden: document.getElementById('boardToolbarGroups').classList.contains('page-hidden'),
    activePage: window.__braAutoModeDebug.getState().activePage,
    tableVisible: !document.getElementById('bomTableView').hidden,
    matkeyVisible: !document.getElementById('bomMatkeyView').hidden,
    viewTabs: document.querySelectorAll('[data-bom-view]').length,
    materialBeforeTable: !!(document.getElementById('bomMatkeyView').compareDocumentPosition(
      document.getElementById('bomTableView')) & Node.DOCUMENT_POSITION_FOLLOWING),
    variantLabels: Array.from(document.querySelectorAll('[data-bom-variant]')).map(x => x.textContent.trim()).join(','),
    persistentMaterialSide: !!document.querySelector('#bomTableView .bm-mat-side'),
    sections: document.querySelectorAll('#bomSections .bm-secband').length,
  })`);
  check(emptyShape.pageHidden === false, 'BOM page stayed hidden after switching tabs');
  check(emptyShape.boardHidden === true, 'Board toolbar groups should hide when BOM is active');
  check(emptyShape.activePage === 'bom', `state.activePage should be 'bom', got ${emptyShape.activePage}`);
  check(emptyShape.tableVisible, 'BOM table should always be visible');
  check(emptyShape.matkeyVisible, 'Material Key should always be visible');
  check(emptyShape.viewTabs === 0, 'Table / Material Key view tabs must be removed');
  check(emptyShape.materialBeforeTable, 'Material Key must stay directly above the BOM table');
  check(emptyShape.variantLabels === 'BOM Solid,BOM Lace', `expected only BOM Solid / BOM Lace controls, got ${emptyShape.variantLabels}`);
  check(emptyShape.persistentMaterialSide === false, 'reference table should not lose width to a persistent material side panel');
  check(emptyShape.sections === 2, `expected FABRIC + TRIM sections, got ${emptyShape.sections}`);

  // --- 1b. Reference seed (US-074): a fresh project's BOM materializes as
  //     the reference sheet's exact 12-row BOM (Tech pack Output/TechPack
  //     output.html #pack-data bom.rows, style RSL vDraft 1.0). Cells are
  //     compared verbatim; the two size-split pairs are checked structurally
  //     (shared groupId per pair) since numeric ids are allocated live. ----
  const SEED_EXPECT = [
    { section: 'FABRIC', scope: 'BOTH', group: null, cells: { description: 'Shell fabric', composition: '', supplier: 'TBD', article: 'AF-SF-01', width: '58"', size: 'ALL', areaOfUse: 'Outer cup, outer cradle, outer UB, back panel' } },
    { section: 'TRIM', scope: 'BOTH', group: null, cells: { description: 'Two-piece molded foam cup', composition: '', supplier: '', article: 'need to source', width: '', size: 'To be size-wise graded', areaOfUse: 'Inner cup' } },
    { section: 'FABRIC', scope: 'BOTH', group: null, cells: { description: 'Power mesh -- front neckline yoke', composition: '', supplier: 'LiFeng', article: 'BR-ME-KT-NL-L-200-LF-338', width: '', size: 'ALL', areaOfUse: 'Front neckline yoke (outer + inner, both variants)' } },
    { section: 'FABRIC', scope: 'BOTH', group: null, cells: { description: 'Power mesh -- back panel (body fabric)', composition: '', supplier: '', article: '', width: '', size: 'ALL', areaOfUse: 'Back panel, full body from underarm to underband (outer, both variants)' } },
    { section: 'FABRIC', scope: 'LACE', group: null, cells: { description: 'Allover lace', composition: '', supplier: 'Yiyuan', article: 'N/A', width: '120cm', size: 'ALL', areaOfUse: 'Outer front cup (overlaid on shell layer)' } },
    { section: 'TRIM', scope: 'BOTH', group: null, cells: { description: 'Oval ring', composition: '', supplier: '', article: '', width: '3 cm (inner width)', size: 'ALL', areaOfUse: 'Strap hardware' } },
    { section: 'TRIM', scope: 'BOTH', group: null, cells: { description: 'Hook and eye', composition: '', supplier: 'Factory source', article: '', width: '5 rows (observed on sketch); column count TBC', size: 'ALL', areaOfUse: 'CB closure' } },
    { section: 'TRIM', scope: 'BOTH', group: null, cells: { description: 'Insert (encased) elastic- UB', composition: '', supplier: 'Mingshipai', article: 'D2008', width: '3 cm', size: 'ALL', areaOfUse: 'UB' } },
    { section: 'TRIM', scope: 'BOTH', group: 'g1', cells: { description: 'Strap elastic', composition: '', supplier: '', article: '', width: '', size: 'S, M, L, XL, M2', areaOfUse: 'Adjustable strap' } },
    { section: 'TRIM', scope: 'BOTH', group: 'g1', cells: { description: 'Strap elastic', composition: '', supplier: '', article: '', width: '', size: '2XL, 3XL, 4XL, 5XL, L2, XL2, 2XL2, 3XL2, 4XL2, 5XL2', areaOfUse: 'Adjustable strap' } },
    { section: 'TRIM', scope: 'BOTH', group: 'g2', cells: { description: 'Nylon coated slider', composition: '', supplier: '', article: '', width: '', size: 'S, M, L, XL, M2', areaOfUse: 'Strap hardware, both attach ends (front + back)' } },
    { section: 'TRIM', scope: 'BOTH', group: 'g2', cells: { description: 'Nylon coated slider', composition: '', supplier: '', article: '', width: '', size: '2XL, 3XL, 4XL, 5XL, L2, XL2, 2XL2, 3XL2, 4XL2, 5XL2', areaOfUse: 'Strap hardware, both attach ends (front + back)' } },
  ];
  const seed = await s.eval(`(() => {
    const bom = window.__braAutoModeDebug.exportProject().state.bom;
    const groupLabels = new Map();
    const rows = bom.rows.map(r => ({
      section: r.section, scope: r.scope,
      group: r.groupId == null ? null
        : (groupLabels.has(r.groupId) ? groupLabels.get(r.groupId)
           : (groupLabels.set(r.groupId, 'g' + (groupLabels.size + 1)), groupLabels.get(r.groupId))),
      cells: r.cells,
    }));
    const solidNums = Array.from(document.querySelectorAll('#bomSections tr[data-bom-row] .bm-num')).map(td => td.textContent);
    document.querySelector('[data-bom-variant="lace"]').click();
    const laceNums = Array.from(document.querySelectorAll('#bomSections tr[data-bom-row] .bm-num')).map(td => td.textContent);
    document.querySelector('[data-bom-variant="solid"]').click();
    return { rows, seedId: bom.seedId, callouts: bom.callouts.length,
      solidNums: solidNums.join(','), laceNums: laceNums.join(',') };
  })()`);
  check(seed.seedId === 'rsl-vdraft-1.0', `fresh BOM should carry the seed id, got ${JSON.stringify(seed.seedId)}`);
  check(seed.callouts === 0, `the seed must not create callouts, got ${seed.callouts}`);
  check(seed.rows.length === 12, `expected the 12 reference seed rows, got ${seed.rows.length}`);
  SEED_EXPECT.forEach((want, i) => {
    check(JSON.stringify(seed.rows[i]) === JSON.stringify(want),
      `seed row ${i + 1} differs from the reference BOM:\n  got  ${JSON.stringify(seed.rows[i])}\n  want ${JSON.stringify(want)}`);
  });
  check(seed.solidNums === '1,2,3,4,5,6,7,8.1,8.2,9.1,9.2',
    `SOLID sheet numbering should match the reference (Allover lace filtered out), got ${seed.solidNums}`);
  check(seed.laceNums === '1,2,3,4,5,6,7,8,9.1,9.2,10.1,10.2',
    `LACE sheet numbering should match the reference, got ${seed.laceNums}`);

  // --- 2. Seed a BOM-owned Solid image with an EMPTY Board. This proves
  //     Material Key no longer depends on measurement/detection images.
  //     The payload carries an already-seeded EMPTY bom — a TD-emptied table —
  //     so the editing steps below keep exact row counts (US-074 would
  //     otherwise re-seed the 12 reference rows on this fresh clone). --------
  await s.eval(`document.querySelector('#pageTabBar [data-page="board"]').click()`);
  await s.waitFor(`document.body.classList.contains('bom-open') === false`, 4000);
  await s.eval(`(async () => {
    await window.__braAutoModeDebug.loadProject({
      format: 'bra-sketch-project', version: 2, savedAt: new Date().toISOString(),
      state: {
        annotations: [],
        images: [],
        eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'cm' },
        nextSequence: 1, idCounter: 3,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0, styleId: '', pomSpecs: {},
        bom: { schemaVersion: 2, rows: [], callouts: [], seedId: 'rsl-vdraft-1.0',
          images: { solid: [{ id: 2, dataURL: '${TINY_PNG}', x: 0, y: 0, width: 400, height: 300, aspect: 1.333, locked: false }], lace: [] } },
      },
    });
  })()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 1`, 4000);
  const emptied = await s.eval(`({ board: window.__braAutoModeDebug.getState().imageCount,
    rows: window.__braAutoModeDebug.exportProject().state.bom.rows.length,
    solid: window.__braAutoModeDebug.exportProject().state.bom.images.solid.length,
    lace: window.__braAutoModeDebug.exportProject().state.bom.images.lace.length })`);
  check(emptied.rows === 0, `a seeded-then-emptied BOM must stay empty on load, got ${emptied.rows} rows`);
  check(emptied.board === 0, `BOM fixture must keep the measurement Board empty, got ${emptied.board} images`);
  check(emptied.solid === 1 && emptied.lace === 0, 'Solid/Lace Material Key images must be independently owned');

  // --- 3. Add a FABRIC row and a TRIM row -----------------------------------
  await s.eval(`document.querySelector('#pageTabBar [data-page="bom"]').click()`);
  await s.waitFor(`document.body.classList.contains('bom-open')`, 4000);
  const rowsAdded = await s.eval(`(() => {
    document.querySelector('[data-bom-add="FABRIC"]').click();
    document.querySelector('[data-bom-add="TRIM"]').click();
    const bom = window.__braAutoModeDebug.exportProject().state.bom;
    return { rows: bom.rows.length, sections: bom.rows.map(r => r.section) };
  })()`);
  check(rowsAdded.rows === 2, `expected 2 rows after adding one of each section, got ${rowsAdded.rows}`);
  check(rowsAdded.sections.join(',') === 'FABRIC,TRIM',
    `expected a FABRIC row then a TRIM row, got ${rowsAdded.sections.join(',')}`);

  const numbering = await s.eval(`Array.from(document.querySelectorAll('#bomSections tr[data-bom-row] .bm-num')).map(td => td.textContent)`);
  check(numbering.join(',') === '1,2', `row numbers should be live-computed FABRIC-then-TRIM, got ${numbering.join(',')}`);

  // --- 3b. Header contract matches the reference sheet (US-073): exact
  //     column order + one bilingual CN span per contract column ----------
  const headerShape = await s.eval(`(() => {
    const hdr = document.querySelector('#bomSections tr.bm-hdr');
    const ths = Array.from(hdr.querySelectorAll('th')).map(th => th.firstChild ? th.firstChild.textContent : '');
    return { ths: ths.join('|'), cn: hdr.querySelectorAll('.bm-cn').length };
  })()`);
  check(headerShape.ths.startsWith('#|DESCRIPTION|TYPE / COMPOSITION|SUPPLIER NAME|ARTICLE #|WIDTH|SIZE|AREA OF USE|MATERIAL IMAGES'),
    `header column order should match the reference contract, got ${headerShape.ths}`);
  check(headerShape.cn === 8, `expected 8 bilingual CN header spans (7 fields + photo), got ${headerShape.cn}`);

  // --- 4. Colorway columns render from state.mainPage.colorways, default to
  //     the colorway's value, and a per-row override is independently
  //     editable without touching the other row --------------------------
  const cwShape = await s.eval(`(() => {
    const mp = window.__braAutoModeDebug.exportProject().state.mainPage;
    const firstRow = document.querySelector('#bomSections tr[data-bom-row]');
    const cwCells = firstRow.querySelectorAll('[data-cw]');
    return { colorways: mp.colorways.length, cwCells: cwCells.length,
      firstCwText: cwCells[0] && cwCells[0].textContent, firstCwLabel: mp.colorways[0].col,
      firstCwDefault: mp.colorways[0].value };
  })()`);
  check(cwShape.colorways === 2, `expected 2 seeded colorways from MAIN PAGE, got ${cwShape.colorways}`);
  check(cwShape.cwCells === 2, `expected one BOM column per colorway, got ${cwShape.cwCells}`);
  check(cwShape.firstCwText === cwShape.firstCwDefault,
    `an untouched BOM colorway cell should default to the colorway's value, got ${JSON.stringify(cwShape.firstCwText)} vs ${JSON.stringify(cwShape.firstCwDefault)}`);

  const cwOverride = await s.eval(`(() => {
    const rows = document.querySelectorAll('#bomSections tr[data-bom-row]');
    const firstCell = rows[0].querySelector('[data-cw]');
    firstCell.textContent = 'Custom colour note';
    firstCell.dispatchEvent(new Event('input', { bubbles: true }));
    firstCell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    const bom = window.__braAutoModeDebug.exportProject().state.bom;
    const secondRowCw = rows[1].querySelector('[data-cw]').textContent;
    return { firstOverride: bom.rows[0].cwOverride, secondRowCwText: secondRowCw };
  })()`);
  check(cwOverride.firstOverride[cwShape.firstCwLabel] === 'Custom colour note',
    `editing a colorway cell should record it under the row's cwOverride, got ${JSON.stringify(cwOverride.firstOverride)}`);
  check(cwOverride.secondRowCwText === cwShape.firstCwDefault,
    `overriding one row's colorway cell must not affect the other row, got ${JSON.stringify(cwOverride.secondRowCwText)}`);

  // --- 5. Scope select moves a row between Solid/Lace filtered views ------
  const scoped = await s.eval(`(() => {
    document.querySelector('[data-bom-variant="lace"]').click();
    const laceRows = document.querySelectorAll('#bomSections tr[data-bom-row]').length;
    document.querySelector('[data-bom-variant="solid"]').click();
    const rows = document.querySelectorAll('#bomSections tr[data-bom-row]');
    const firstRowId = rows[0].dataset.bomRow;
    const sel = rows[0].querySelector('[data-scope]');
    sel.value = 'LACE';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const solidRowsAfter = document.querySelectorAll('#bomSections tr[data-bom-row]').length;
    document.querySelector('[data-bom-variant="lace"]').click();
    const laceRowsAfter = document.querySelectorAll('#bomSections tr[data-bom-row]').length;
    document.querySelector('[data-bom-variant="solid"]').click();
    return { laceRowsBefore: laceRows, firstRowId, solidRowsAfter, laceRowsAfter };
  })()`);
  check(scoped.laceRowsBefore === 2, `a BOTH-scope row should show on Lace too, got ${scoped.laceRowsBefore}`);
  check(scoped.solidRowsAfter === 1, `setting a row's scope to LACE should drop it from the Solid view, got ${scoped.solidRowsAfter}`);
  check(scoped.laceRowsAfter === 2, `the LACE-scoped row should still show on Lace, got ${scoped.laceRowsAfter}`);

  // Put the scope back to BOTH so later steps see both rows on Solid again.
  // Switch to Lace first (where the LACE-scoped row is still visible) and
  // locate it by the id captured above — on Solid it's filtered out, so a
  // plain first-row selector would silently grab the other row instead.
  await s.eval(`(() => {
    document.querySelector('[data-bom-variant="lace"]').click();
    const row = document.querySelector('#bomSections tr[data-bom-row="${scoped.firstRowId}"]');
    const sel = row.querySelector('[data-scope]');
    sel.value = 'BOTH';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-bom-variant="solid"]').click();
  })()`);
  await s.waitFor(`document.querySelectorAll('#bomSections tr[data-bom-row]').length === 2`, 2000);

  // --- 6. Reference in-cell dropdown fills empty cells but never overwrites
  //     a cell the TD already typed ---------------------------------------

  const supplierTyped = await s.eval(`(() => {
    const cell = document.querySelector('#bomSections tr[data-bom-row] [data-cell="supplier"]');
    cell.textContent = 'TD Chosen Supplier';
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return window.__braAutoModeDebug.exportProject().state.bom.rows[0].cells.supplier;
  })()`);
  check(supplierTyped === 'TD Chosen Supplier', `free-typed supplier not written, got ${JSON.stringify(supplierTyped)}`);

  const materialFilled = await s.eval(`(() => {
    const trigger = document.querySelector('#bomSections tr[data-bom-row] [data-bom-dd$="|description"]');
    if (!trigger) return { ok: false, reason: 'no in-cell suggestion trigger' };
    trigger.click();
    const btn = document.querySelector('#bomDdMenu [data-bm-pick]');
    if (!btn) return { ok: false, reason: 'no suggestion item rendered' };
    const name = btn.textContent;
    btn.click();
    const row = window.__braAutoModeDebug.exportProject().state.bom.rows[0];
    return { ok: true, description: row.cells.description, supplier: row.cells.supplier, name };
  })()`);
  check(materialFilled.ok, 'in-cell material pick: ' + (materialFilled.reason || ''));
  check(materialFilled.description.length > 0 && materialFilled.name.indexOf(materialFilled.description) === 0,
    `picking a material should set the row's description, got ${JSON.stringify(materialFilled.description)}`);
  check(materialFilled.supplier === 'TD Chosen Supplier',
    `picking a material must not overwrite a cell the TD already typed into, got ${JSON.stringify(materialFilled.supplier)}`);

  // --- 7. Explicit tools + batch placement: Add Callouts stays active,
  //     advances to the next uncovered row, then returns to Select. ------
  const initialTools = await s.eval(`({
    select: document.getElementById('bomSelectToolBtn').getAttribute('aria-pressed'),
    callout: document.getElementById('bomAddCalloutBtn').getAttribute('aria-pressed'),
    leaderDisabled: document.getElementById('bomAddArrowBtn').disabled,
    labels: ['bomSelectToolBtn','bomAddCalloutBtn','bomAddArrowBtn'].map(id => document.getElementById(id).textContent.trim()).join('|')
  })`);
  check(initialTools.select === 'true' && initialTools.callout === 'false', 'Select should be the default Material Key tool');
  check(initialTools.leaderDisabled, 'Add Leaders must be disabled until a callout is selected');
  check(initialTools.labels === '↖ Select|＋ Add Callouts|＋ Add Leaders', `unexpected tool labels: ${initialTools.labels}`);

  await s.eval(`document.getElementById('bomAddCalloutBtn').click()`);
  await s.waitFor(`document.getElementById('bomAddCalloutBtn').classList.contains('bm-tool-active')`, 2000);

  const firstPlaced = await s.eval(`(() => {
    const canvas = document.getElementById('bomMatkeyCanvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
    const bom = window.__braAutoModeDebug.exportProject().state.bom;
    const selectedRow = document.querySelector('#bomSections tr.bm-row-selected');
    return { callouts: bom.callouts.length,
      calloutActive: document.getElementById('bomAddCalloutBtn').classList.contains('bm-tool-active'),
      selectedRowId: selectedRow && selectedRow.dataset.bomRow,
      placedRowId: String(bom.callouts[0].rowId) };
  })()`);
  check(firstPlaced.callouts === 1, `expected first batch callout, got ${firstPlaced.callouts}`);
  check(firstPlaced.calloutActive, 'Add Callouts should remain active while an uncovered row remains');
  check(firstPlaced.selectedRowId && firstPlaced.selectedRowId !== firstPlaced.placedRowId,
    'batch placement should advance the highlighted BOM row');

  const batchDone = await s.eval(`(() => {
    const canvas = document.getElementById('bomMatkeyCanvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
    const bom = window.__braAutoModeDebug.exportProject().state.bom;
    return { callouts: bom.callouts.length,
      rowIds: bom.callouts.map(c => String(c.rowId)).sort().join(','),
      tableRowIds: bom.rows.map(r => String(r.id)).sort().join(','),
      selectActive: document.getElementById('bomSelectToolBtn').classList.contains('bm-tool-active'),
      sideCalloutVisible: !document.getElementById('bomMkSideCallout').hidden,
      leaderEnabled: !document.getElementById('bomAddArrowBtn').disabled };
  })()`);
  check(batchDone.callouts === 2, `expected 2 callouts after batch placement, got ${batchDone.callouts}`);
  check(batchDone.rowIds === batchDone.tableRowIds, `each BOM row should own exactly one callout: ${batchDone.rowIds} vs ${batchDone.tableRowIds}`);
  check(batchDone.selectActive, 'finishing all visible rows should return to Select');
  check(batchDone.sideCalloutVisible && batchDone.leaderEnabled, 'the final callout should stay selected and enable Add Leaders');

  // --- 8. Row identity is live and one-to-one: description edits flow to
  //     print labels, and occupied rows cannot be selected for relinking. -
  const syncShape = await s.eval(`(() => {
    const selected = document.getElementById('bomMkRowSelect');
    const disabledOther = Array.from(selected.options).some(o => !o.selected && o.disabled);
    const callout = window.__braAutoModeDebug.exportProject().state.bom.callouts.find(c => String(c.rowId) === selected.value);
    const row = document.querySelector('#bomSections tr[data-bom-row="' + callout.rowId + '"]');
    const cell = row.querySelector('[data-cell="description"]');
    const before = cell.textContent;
    cell.textContent = 'Live Synced Material';
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    const printHasLive = Array.from(document.querySelectorAll('#bomPrintSheets .bm-print-label')).some(x => x.textContent.includes('Live Synced Material'));
    cell.textContent = before;
    cell.dispatchEvent(new Event('input', { bubbles: true }));
    cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return { disabledOther, printHasLive };
  })()`);
  check(syncShape.disabledOther, 'a row that already owns a callout must be disabled in the relink select');
  check(syncShape.printHasLive, 'editing the BOM description should update the linked callout label immediately');

  // --- 9. Add Leaders is persistent, constrained to the callout image,
  //     and Select/Escape ends it. --------------------------------------
  const leadersAdded = await s.eval(`(() => {
    document.getElementById('bomAddArrowBtn').click();
    const canvas = document.getElementById('bomMatkeyCanvas');
    const rect = canvas.getBoundingClientRect();
    const p1 = { x: rect.left + rect.width / 2 + 12, y: rect.top + rect.height / 2 - 6 };
    const p2 = { x: rect.left + rect.width / 2 - 12, y: rect.top + rect.height / 2 + 6 };
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: p1.x, clientY: p1.y }));
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: p2.x, clientY: p2.y }));
    const selectedId = document.getElementById('bomMkRowSelect').value;
    const c = window.__braAutoModeDebug.exportProject().state.bom.callouts.find(x => String(x.rowId) === selectedId);
    return { targets: c.targets.length, p1, p2,
      leaderActive: document.getElementById('bomAddArrowBtn').classList.contains('bm-tool-active') };
  })()`);
  check(leadersAdded.targets === 3, `two persistent Add Leaders clicks should produce 3 targets total, got ${leadersAdded.targets}`);
  check(leadersAdded.leaderActive, 'Add Leaders should remain active after each target');

  const escapedTool = await s.eval(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    return { select: document.getElementById('bomSelectToolBtn').classList.contains('bm-tool-active'),
      leader: document.getElementById('bomAddArrowBtn').classList.contains('bm-tool-active') };
  })()`);
  check(escapedTool.select && !escapedTool.leader, 'Escape should finish Add Leaders and return to Select');

  const arrowsRemoved = await s.eval(`(() => {
    const canvas = document.getElementById('bomMatkeyCanvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true,
      clientX: rect.left + rect.width / 2 - 12, clientY: rect.top + rect.height / 2 + 6 }));
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true,
      clientX: rect.left + rect.width / 2 + 12, clientY: rect.top + rect.height / 2 - 6 }));
    const selectedId = document.getElementById('bomMkRowSelect').value;
    return window.__braAutoModeDebug.exportProject().state.bom.callouts.find(x => String(x.rowId) === selectedId).targets.length;
  })()`);
  check(arrowsRemoved === 1, `double-click should remove added leaders individually, got ${arrowsRemoved} target(s)`);

  // --- 10. Select drags a target independently, and Undo restores it. ---
  const dragRowId = await s.eval(`document.getElementById('bomMkRowSelect').value`);
  const beforeDrag = await s.eval(`window.__braAutoModeDebug.exportProject().state.bom.callouts.find(c => String(c.rowId) === '${dragRowId}').targets[0]`);
  const dragged = await s.eval(`(() => {
    const canvas = document.getElementById('bomMatkeyCanvas');
    const rect = canvas.getBoundingClientRect();
    const startX = rect.left + rect.width / 2, startY = rect.top + rect.height / 2;
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: startX + 8, clientY: startY + 3 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return window.__braAutoModeDebug.exportProject().state.bom.callouts.find(c => String(c.rowId) === '${dragRowId}').targets[0];
  })()`);
  check(dragged.nx !== beforeDrag.nx || dragged.ny !== beforeDrag.ny, 'Select should drag one leader target');

  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`
    (() => {
      const t = window.__braAutoModeDebug.exportProject().state.bom.callouts.find(c => String(c.rowId) === '${dragRowId}').targets[0];
      return t.nx === ${beforeDrag.nx} && t.ny === ${beforeDrag.ny};
    })()
  `, 4000);
  passed += 1;

  // --- 11. Deleting a selected callout leaves its row, and Undo restores
  //     the one-to-one link. ---------------------------------------------
  await s.eval(`document.getElementById('bomDeleteCalloutBtn').click()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.callouts.length === 1`, 4000);
  const afterDelete = await s.eval(`({
    rows: window.__braAutoModeDebug.exportProject().state.bom.rows.length,
    callouts: window.__braAutoModeDebug.exportProject().state.bom.callouts.length,
    sideEmptyVisible: !document.getElementById('bomMkSideEmpty').hidden,
  })`);
  check(afterDelete.rows === 2 && afterDelete.callouts === 1, 'deleting a callout must not delete its BOM row');
  check(afterDelete.sideEmptyVisible, 'side panel should fall back to the empty state after callout delete');

  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.callouts.length === 2`, 4000);
  passed += 1;

  // --- 11b. A row's ⊕ selects its existing callout and never duplicates it.
  const mkExisting = await s.eval(`(() => {
    const target = document.querySelectorAll('#bomSections tr[data-bom-row]')[0];
    const rowId = target.dataset.bomRow;
    target.querySelector('[data-bom-mk]').click();
    return { rowId,
      callouts: window.__braAutoModeDebug.exportProject().state.bom.callouts.length,
      selectedRow: document.getElementById('bomMkRowSelect').value,
      selectActive: document.getElementById('bomSelectToolBtn').classList.contains('bm-tool-active'),
      matkeyVisible: !document.getElementById('bomMatkeyView').hidden,
      tableVisible: !document.getElementById('bomTableView').hidden };
  })()`);
  check(mkExisting.matkeyVisible && mkExisting.tableVisible, 'row ⊕ must keep Material Key and table attached');
  check(mkExisting.callouts === 2, `row ⊕ must not duplicate an existing callout, got ${mkExisting.callouts}`);
  check(mkExisting.selectedRow === mkExisting.rowId && mkExisting.selectActive,
    'row ⊕ should select its existing callout in Select mode');

  // --- 11c. Print container (US-073): BOM-SOLID + BOM-LACE sheets always
  //     rendered, scope-filtered, with zero editor affordances ------------
  const printShape = await s.eval(`(() => {
    const sheets = document.querySelectorAll('#bomPrintSheets .bm-print-sheet');
    const names = Array.from(document.querySelectorAll('#bomPrintSheets .bm-shm')).map(x => x.textContent);
    const rowCounts = Array.from(sheets).map(sh => sh.querySelectorAll('td.bm-num').length);
    const chrome = document.querySelectorAll('#bomPrintSheets .bm-dd, #bomPrintSheets td.act, #bomPrintSheets .bm-addrow, #bomPrintSheets [contenteditable]').length;
    const matkeys = Array.from(sheets).map(sh => sh.querySelectorAll('.bm-print-matkey > img').length).join(',');
    const labels = Array.from(sheets).map(sh => sh.querySelectorAll('.bm-print-label').length).join(',');
    const orderOk = Array.from(sheets).every(sh => {
      const mk = sh.querySelector('.bm-print-matkey');
      const table = sh.querySelector('.bm-table');
      return !!mk && !!table && !!(mk.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    return { sheets: sheets.length, names: names.join(','), rowCounts: rowCounts.join(','), chrome, matkeys, labels, orderOk };
  })()`);
  check(printShape.sheets === 2, `expected two print sheets, got ${printShape.sheets}`);
  check(printShape.names === 'BOM-SOLID,BOM-LACE', `print sheet names wrong: ${printShape.names}`);
  check(printShape.rowCounts === '2,2', `BOTH-scope rows should print on both sheets, got ${printShape.rowCounts}`);
  check(printShape.chrome === 0, 'print sheets must carry no editor affordances');
  check(printShape.matkeys === '1,0', `Solid/Lace print must use their own image collections, got ${printShape.matkeys}`);
  check(printShape.labels === '2,0', `Solid print should carry its two material callouts, got ${printShape.labels}`);
  check(printShape.orderOk, 'each print sheet must place Material Key before its BOM table');

  const printScoped = await s.eval(`(() => {
    const first = document.querySelector('#bomSections tr[data-bom-row]');
    const id = first.dataset.bomRow;
    const sel = first.querySelector('[data-scope]');
    sel.value = 'LACE';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const counts = Array.from(document.querySelectorAll('#bomPrintSheets .bm-print-sheet'))
      .map(sh => sh.querySelectorAll('td.bm-num').length).join(',');
    const afterNarrow = window.__braAutoModeDebug.exportProject().state.bom.callouts.length;
    const labelsAfterNarrow = Array.from(document.querySelectorAll('#bomPrintSheets .bm-print-sheet'))
      .map(sh => sh.querySelectorAll('.bm-print-label').length).join(',');
    document.querySelector('[data-bom-variant="lace"]').click();
    const row = document.querySelector('#bomSections tr[data-bom-row="' + id + '"]');
    const sel2 = row.querySelector('[data-scope]');
    sel2.value = 'BOTH';
    sel2.dispatchEvent(new Event('change', { bubbles: true }));
    const afterWiden = window.__braAutoModeDebug.exportProject().state.bom.callouts.length;
    document.querySelector('[data-bom-variant="solid"]').click();
    return { counts, afterNarrow, afterWiden, labelsAfterNarrow };
  })()`);
  check(printScoped.counts === '1,2', `a LACE-scoped row must print only on the LACE sheet, got ${printScoped.counts}`);
  check(printScoped.afterNarrow === 1 && printScoped.labelsAfterNarrow === '1,0',
    `narrowing scope should remove the excluded Solid callout, got ${printScoped.afterNarrow} / ${printScoped.labelsAfterNarrow}`);
  check(printScoped.afterWiden === 1, 'widening scope must not invent a callout on the newly included variant');

  await s.eval(`document.getElementById('undoBtn').click()`); // BOTH -> LACE, still no callout
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.rows.some(r => r.scope === 'LACE')`, 4000);
  await s.eval(`document.getElementById('undoBtn').click()`); // restore pre-narrow BOTH + linked callout
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.callouts.length === 2`, 4000);
  passed += 2;

  // --- 11d. Deleting a BOM row removes its owned callout in the same Undo. -
  const rowOwnedDelete = await s.eval(`(() => {
    const row = document.querySelector('#bomSections tr[data-bom-row]');
    row.querySelector('[data-bom-rm]').click();
    const bom = window.__braAutoModeDebug.exportProject().state.bom;
    return { rows: bom.rows.length, callouts: bom.callouts.length };
  })()`);
  check(rowOwnedDelete.rows === 1 && rowOwnedDelete.callouts === 1,
    `deleting one BOM row should remove its one owned callout, got ${JSON.stringify(rowOwnedDelete)}`);
  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`(() => { const b = window.__braAutoModeDebug.exportProject().state.bom; return b.rows.length === 2 && b.callouts.length === 2; })()`, 4000);
  passed += 1;

  // --- 12. BOM is metadata: it adds no POM, anchor, or draft ----------------
  const untouched = await s.eval(`(() => {
    const st = window.__braAutoModeDebug.getState();
    return { anchors: st.anchorCount, drafts: st.draftCount };
  })()`);
  check(untouched.anchors === 0 && untouched.drafts === 0,
    'BOM rows/callouts must not create anchors or drafts');

  // --- 13. A pre-US-072 project still opens; its first-ever BOM
  //     materializes as the 12-row reference seed (US-074) -----------------
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
    const bom = window.__braAutoModeDebug.exportProject().state.bom;
    return { rows: bom.rows.length, callouts: bom.callouts.length,
      seedId: bom.seedId, keys: Object.keys(bom).sort().join(',') };
  })()`);
  check(legacy.rows === 12, `a pre-US-072 project should seed the 12 reference rows, got ${legacy.rows}`);
  check(legacy.callouts === 0, `a pre-US-072 project should seed an empty callouts list, got ${legacy.callouts}`);
  check(legacy.seedId === 'rsl-vdraft-1.0', `legacy load should stamp the seed id, got ${JSON.stringify(legacy.seedId)}`);
  check(legacy.keys === 'callouts,images,rows,schemaVersion,seedId', `unexpected bom shape on a legacy load: ${legacy.keys}`);

  // --- 14. A saved BOM page survives the round-trip -------------------------
  // The legacy load in step 13 wiped state.images; seed one again the same
  // way (again with an already-seeded empty bom, so the single FABRIC row
  // added below is the only row).
  await s.eval(`(async () => {
    await window.__braAutoModeDebug.loadProject({
      format: 'bra-sketch-project', version: 2, savedAt: new Date().toISOString(),
      state: {
        annotations: [],
        images: [],
        eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'cm' },
        nextSequence: 1, idCounter: 3,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0, styleId: '', pomSpecs: {},
        bom: { schemaVersion: 2, rows: [], callouts: [], seedId: 'rsl-vdraft-1.0',
          images: { solid: [{ id: 2, dataURL: '${TINY_PNG}', x: 0, y: 0, width: 400, height: 300, aspect: 1.333, locked: false }], lace: [] } },
      },
    });
  })()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 1`, 4000);
  await s.eval(`document.querySelector('#pageTabBar [data-page="bom"]').click()`);
  await s.waitFor(`document.body.classList.contains('bom-open')`, 4000);
  await s.eval(`document.querySelector('[data-bom-add="FABRIC"]').click()`);
  await s.eval(`document.getElementById('bomAddCalloutBtn').click()`);
  await s.eval(`(() => {
    const canvas = document.getElementById('bomMatkeyCanvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  })()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.callouts.length === 1`, 4000);

  const roundTrip = await s.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    const before = api.exportProject();
    before.state.bom.rows[0].cells.description = 'Round Trip Material';
    before.state.bom.rows[0].scope = 'SOLID';
    before.state.bom.rows[0].cwOverride = { 'COL 1': 'Round Trip Colour' };
    await api.loadProject(before);
    const after = api.exportProject().state.bom;
    return { description: after.rows[0].cells.description, scope: after.rows[0].scope,
      cwOverride: after.rows[0].cwOverride, rows: after.rows.length, callouts: after.callouts.length,
      boardImages: api.getState().imageCount, bomImages: after.images.solid.length,
      bomBitmap: !!after.images.solid[0].dataURL };
  })()`);
  check(roundTrip.description === 'Round Trip Material', `save/open lost the row description: ${roundTrip.description}`);
  check(roundTrip.scope === 'SOLID', `save/open lost the row scope: ${roundTrip.scope}`);
  check(roundTrip.cwOverride['COL 1'] === 'Round Trip Colour', `save/open lost a colorway override: ${JSON.stringify(roundTrip.cwOverride)}`);
  check(roundTrip.rows === 1, `save/open lost a row, got ${roundTrip.rows}`);
  check(roundTrip.callouts === 1, `save/open lost a callout, got ${roundTrip.callouts}`);
  check(roundTrip.boardImages === 0, `BOM round-trip must not populate Board images, got ${roundTrip.boardImages}`);
  check(roundTrip.bomImages === 1 && roundTrip.bomBitmap, 'save/open must preserve BOM image metadata and bitmap bytes');

  // --- 15. Repeated image paste adds panels to the active BOM variant;
  //     moving/deleting a panel is undoable and never touches Board images.
  const pasteOne = async () => s.eval(`(async () => {
    document.querySelector('#pageTabBar [data-page="bom"]').click();
    document.querySelector('[data-bom-variant="solid"]').click();
    const blob = await (await fetch('${TINY_PNG}')).blob();
    const file = new File([blob], 'pasted.png', { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => file }] } });
    document.getElementById('bomMatkeyCanvas').dispatchEvent(event);
    return true;
  })()`);
  await pasteOne();
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 2`, 4000);
  await pasteOne();
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 3`, 4000);
  const pasteShape = await s.eval(`({
    board: window.__braAutoModeDebug.getState().imageCount,
    solid: window.__braAutoModeDebug.exportProject().state.bom.images.solid.length,
    lace: window.__braAutoModeDebug.exportProject().state.bom.images.lace.length
  })`);
  check(pasteShape.board === 0, `BOM paste must not add a Board image, got ${pasteShape.board}`);
  check(pasteShape.solid === 3 && pasteShape.lace === 0,
    `repeated paste must add only to active Solid variant, got ${JSON.stringify(pasteShape)}`);

  const beforeDeleteIds = await s.eval(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.map(x => x.id)`);
  await s.eval(`(() => {
    const canvas = document.getElementById('bomMatkeyCanvas');
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true,
      clientX: r.left + r.width * 0.84, clientY: r.top + r.height * 0.5 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.getElementById('bomDeleteImageBtn').click();
  })()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 2`, 4000);
  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.length === 3`, 4000);
  const restoredIds = await s.eval(`window.__braAutoModeDebug.exportProject().state.bom.images.solid.map(x => x.id)`);
  check(JSON.stringify(restoredIds) === JSON.stringify(beforeDeleteIds), 'undo must restore the deleted BOM image metadata');

  await s.close();
  console.log(`PASS  bom-check   ${passed}/${passed} assertions ok`);
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
