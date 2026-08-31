#!/usr/bin/env node
// US-082: Browser-level contract for the Contextual Board Toolbar.
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

// US-097: the Tools menu now has two regions — the drawing tools, and the
// saved-shape library (rows + its own actions). This suite's claim has always
// been "every drawing tool exists and is reachable", never "the menu contains
// nothing else", so the tool assertions read the TOOL region specifically.
// Keyboard navigation still covers the whole menu, which is asserted separately
// below: a keyboard user must be able to reach a saved shape.
const TOOL_MENU_ITEMS = `Array.from(document.querySelectorAll('#toolsMenuList [role="menuitem"]'))
  .filter(b => !b.closest('#shapeStampList') && !b.closest('.preset-menu-actions'))`;

const VISIBLE_BUTTONS = `Array.from(document.querySelectorAll('#boardToolbarGroups button'))
  .filter(button => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return !button.hidden && style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  }).map(button => button.id)`;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'board-toolbar-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    `${started.baseUrl}/index.html?toolbar=${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`document.querySelectorAll('#specBody tr').length > 0`, 8000);
  console.log('board-toolbar-check: app ready');

  // Empty Auto: mode, add, File, More. Disabled workflow controls do not
  // occupy the primary surface.
  const emptyAuto = await s.eval(`({
    buttons: ${VISIBLE_BUTTONS},
    primary: Array.from(document.querySelectorAll('#boardToolbarGroups button'))
      .filter(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0
        && (b.classList.contains('primary-btn') || b.classList.contains('context-primary')))
      .map(b => b.id),
    toolbarHeight: Math.round(document.querySelector('.toolbar').getBoundingClientRect().height),
  })`);
  check(JSON.stringify(emptyAuto.buttons) === JSON.stringify([
    'modeManualBtn', 'modeAutoBtn', 'addImageBtn', 'fileMenuBtn', 'moreMenuBtn',
  ]), `empty Auto controls wrong: ${JSON.stringify(emptyAuto.buttons)}`);
  check(emptyAuto.primary.join(',') === 'addImageBtn', `empty Auto primary should be Add Image, got ${emptyAuto.primary}`);
  check(emptyAuto.toolbarHeight < 115, `empty Auto toolbar should stay within two rows, height ${emptyAuto.toolbarHeight}`);
  console.log('board-toolbar-check: empty Auto ok');

  // Empty Manual: drawing entry points remain direct; line settings,
  // selection actions, and Export stay hidden until Board content exists.
  await s.eval(`document.getElementById('modeManualBtn').click()`);
  const emptyManual = await s.eval(`({
    buttons: ${VISIBLE_BUTTONS},
    contextHidden: document.getElementById('boardContextActions').hidden,
    lineSettingsHidden: document.querySelector('.board-line-settings').hidden,
    exportHidden: document.getElementById('exportMenuWrap').hidden,
    units: Array.from(document.querySelectorAll('#boardToolbarGroups > :not(.toolbar-spacer)'))
      .filter(el => { const r=el.getBoundingClientRect(); return !el.hidden && getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0; }).length,
  })`);
  // The exact SET, not a count. US-092 added a fifth drawing tool and this
  // assertion failed as "9 direct buttons, got 10" — true, but it does not say
  // WHICH control appeared, which is the only thing a reviewer needs to decide
  // whether the change belongs. US-093 then consolidated Straight/Curved/
  // Eraser/Text into one "toolsMenuBtn" drop-down (freeing room for the new,
  // selection-gated "Add point" tool) — so those four ids no longer appear as
  // DIRECT toolbar children (they're menu items, hidden until opened), and
  // the three claims this section really makes (no line settings, no
  // selection actions, no Export on an empty board) are asserted separately
  // below.
  //
  // US-093 / ADR 0053 code review, 2026-08-21: a FOURTH claim went missing with
  // them — that every drawing tool still exists and is reachable at all.
  // VISIBLE_BUTTONS filters on rect.width > 0, and a button inside the `hidden`
  // #toolsMenuList measures 0x0, so deleting toolCurved from index.html would
  // have left this whole suite green. The Tools-menu block further down opens
  // the drop-down and reads its contents, which is where that claim now lives.
  // US-102: sketchFocusBtn joins the direct-child list here — the single
  // Sketch Focus toggle is a manual-only control with no other gate (unlike
  // the drawing tools it sits beside, which moved into toolsMenuBtn under
  // US-093), so it is exactly as reachable on an empty board as the
  // Manual/Auto switch itself. POM Focus is the implicit default and has no
  // button of its own (2026-08-28 correction — see
  // docs/archive/stories/E01-manual-mode/US-102-sketch-mode-handoff.md
  // (archived 2026-08-29); the earlier two-button design is wrong).
  check(JSON.stringify(emptyManual.buttons) === JSON.stringify([
    'modeManualBtn', 'modeAutoBtn', 'sketchFocusBtn', 'addImageBtn',
    'toolSelect', 'toolsMenuBtn',
    'stitchesBtn', 'libraryBtn', 'fileMenuBtn', 'moreMenuBtn',
  ]), `empty Manual controls wrong: ${JSON.stringify(emptyManual.buttons)}`);
  check(emptyManual.contextHidden, 'selection actions should be hidden with no selection/history');
  check(emptyManual.lineSettingsHidden, 'line settings should be hidden on an empty Manual Board');
  check(emptyManual.exportHidden, 'Export should be hidden on an empty Manual Board');
  check(emptyManual.units <= 6, `empty Manual should have at most 6 direct toolbar units, got ${emptyManual.units}`);
  console.log('board-toolbar-check: empty Manual ok');

  // Menus are accessible: trigger state, first enabled focus, keyboard
  // traversal, and Escape-to-close/focus-return.
  await s.eval(`document.getElementById('fileMenuBtn').click()`);
  const fileOpen = await s.eval(`({
    open: !document.getElementById('fileMenuList').hidden,
    expanded: document.getElementById('fileMenuBtn').getAttribute('aria-expanded'),
    focus: document.activeElement.id,
  })`);
  check(fileOpen.open && fileOpen.expanded === 'true', 'File menu did not open with aria-expanded=true');
  check(fileOpen.focus === 'addImageMenuBtn', `File menu should focus first enabled item, got ${fileOpen.focus}`);
  await s.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true }))`);
  check(await s.eval(`document.activeElement.id === 'openProjectBtn'`), 'ArrowDown should skip disabled Save and focus Open');
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  const fileClosed = await s.eval(`({ hidden:document.getElementById('fileMenuList').hidden,
    expanded:document.getElementById('fileMenuBtn').getAttribute('aria-expanded'), focus:document.activeElement.id })`);
  check(fileClosed.hidden && fileClosed.expanded === 'false', 'Escape did not close File menu');
  check(fileClosed.focus === 'fileMenuBtn', `Escape should return focus to File trigger, got ${fileClosed.focus}`);
  console.log('board-toolbar-check: menu keyboard ok');

  // The Tools drop-down carries the same contract as File/Export/More above,
  // and it is the only place the drawing tools can still be seen — see
  // the empty-Manual comment. Assert the ids it holds, which of them are
  // actually reachable right now, and the same focus/ARIA/Escape behaviour.
  await s.eval(`document.getElementById('toolsMenuBtn').click()`);
  const toolsOpen = await s.eval(`({
    open: !document.getElementById('toolsMenuList').hidden,
    expanded: document.getElementById('toolsMenuBtn').getAttribute('aria-expanded'),
    items: ${TOOL_MENU_ITEMS}.map(button => button.id),
    reachable: ${TOOL_MENU_ITEMS}
      .filter(button => !button.hidden && !button.disabled && button.offsetParent !== null).map(button => button.id),
    // The WHOLE menu, library included — what keyboard navigation actually walks.
    allReachable: Array.from(document.querySelectorAll('#toolsMenuList [role="menuitem"]'))
      .filter(button => !button.hidden && !button.disabled && button.offsetParent !== null).map(button => button.id),
    hasShapeLibrary: !!document.querySelector('#toolsMenuList #shapeStampList'),
    hasSaveTemplate: !!document.querySelector('#toolsMenuList #shapeStampSaveBtn'),
    focus: document.activeElement.id,
  })`);
  check(toolsOpen.open && toolsOpen.expanded === 'true', 'Tools menu did not open with aria-expanded=true');
  check(JSON.stringify(toolsOpen.items) === JSON.stringify([
    'toolStraight', 'toolCurved', 'toolEraser', 'toolText', 'toolRectangle', 'toolCircle', 'toolHexagon',
  ]), `Tools menu must hold all seven drawing tools, got ${JSON.stringify(toolsOpen.items)}`);
  // Eraser paints white over a photo, so it stays out of reach until one
  // exists; the populated-Manual check below is where it has to come back.
  check(JSON.stringify(toolsOpen.reachable) === JSON.stringify([
    'toolStraight', 'toolCurved', 'toolText', 'toolRectangle', 'toolCircle', 'toolHexagon',
  ]), `empty Manual should offer Straight/Curved/Text and withhold Eraser, got ${JSON.stringify(toolsOpen.reachable)}`);
  check(toolsOpen.focus === 'toolStraight', `Tools menu should focus first enabled item, got ${toolsOpen.focus}`);
  // US-107: browsing/picking Templates moved out of the Tools menu entirely,
  // into the unified Library dialog (#libraryBtn) — board-toolbar-check owns
  // proving it is NOT back here; library-manager-check.mjs owns the dialog
  // itself. "Save selection as Template…" stays, since it reads the board's
  // live selection rather than browsing what is already saved.
  check(toolsOpen.hasShapeLibrary === false,
    'the Templates browse list must not be back in the Tools menu');
  check(toolsOpen.hasSaveTemplate === true,
    '"Save selection as Template…" stays in the Tools menu (a board-selection action, not browsing)');
  await s.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true }))`);
  // US-102: in POM Focus (the default), the Template library and Smart Align
  // are hidden (.sketch-mode-only), so End now lands on the last TOOL — this
  // is the claim the old test made before the library existed, now true
  // again in POM Focus specifically.
  check(await s.eval(`document.activeElement.id`) === 'toolHexagon',
    `POM Focus: End should focus the last TOOL, the library being hidden `
    + `(got ${await s.eval('document.activeElement.id')})`);
  check(toolsOpen.allReachable.length === toolsOpen.reachable.length,
    'POM Focus: the hidden library must not contribute extra reachable menu items');

  // Sketch Focus: the library (and Smart Align) become reachable, and End
  // now walks all the way to the last action in the menu — the US-097 claim
  // this test made before US-102 existed, now true only in this state. US-104
  // added "Open DXF file…" after the Template library's own actions, making
  // it the last item instead of shapeStampImportBtn; ADR 0070 then added
  // "Pattern pieces…" right after that, so it is now the last item instead.
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  await s.eval(`document.getElementById('sketchFocusBtn').click()`);
  await s.eval(`document.getElementById('toolsMenuBtn').click()`);
  const toolsOpenSketch = await s.eval(`({
    reachable: ${TOOL_MENU_ITEMS}
      .filter(button => !button.hidden && !button.disabled && button.offsetParent !== null).map(button => button.id),
    allReachable: Array.from(document.querySelectorAll('#toolsMenuList [role="menuitem"]'))
      .filter(button => !button.hidden && !button.disabled && button.offsetParent !== null).map(button => button.id),
  })`);
  await s.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true }))`);
  // Named by id, not read back from the same query the implementation walks —
  // comparing an implementation against itself proves only that it is
  // self-consistent.
  check(await s.eval(`document.activeElement.id`) === 'patternPiecesBtn',
    `Sketch Focus: End should focus the last item in the whole menu — "Pattern pieces…" `
    + `(got ${await s.eval('document.activeElement.id')})`);
  check(toolsOpenSketch.allReachable.length > toolsOpenSketch.reachable.length,
    'Sketch Focus: precondition: the library section really does add reachable items, or the check '
    + 'above is just the old tool-only claim in disguise');

  // With an EMPTY library the checks above only prove the library's ACTIONS are
  // reachable. The claim worth making is that a saved SHAPE is, so seed one and
  // reach it. US-107: that path is the unified Library dialog now (#libraryBtn),
  // not a Tools-menu row — library-manager-check.mjs owns the dialog's full
  // rail/search/card contract; this is a lighter smoke check that the seeded
  // shape actually surfaces there and arms placement from a real click.
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  const seededRow = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    if (!d || typeof d.importShapeStampsJson !== 'function') return { skipped: true };
    d.importShapeStampsJson(JSON.stringify({ stamps: [{
      id: 'st-toolbar-fixture', name: 'Toolbar fixture', type: 'straight',
      start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, aspect: 1,
      style: 'solid', color: 'red', lineWidth: 2.5, arrowType: 'none',
    }] }));
    document.getElementById('libraryBtn').click();
    const cards = Array.from(document.querySelectorAll('[data-stamp-id]'));
    const card = cards.find(c => c.textContent.indexOf('Toolbar fixture') !== -1);
    if (card) card.querySelector('[data-card-action="place"]').click();
    const armed = document.getElementById('toolsMenuBtn').textContent;
    return { skipped: false, cardCount: cards.length, armed, dialogClosed: !document.querySelector('.picker-overlay') };
  })()`);
  check(seededRow.skipped !== true, 'the shape-stamp debug hook is available to seed a fixture');
  check(seededRow.cardCount === 1, `precondition: one saved shape reached the Library dialog (got ${seededRow.cardCount})`);
  check(seededRow.armed === 'Tools: Toolbar fixture',
    `a saved SHAPE is reachable from the Library dialog, and clicking its card arms it — not just `
    + `the dialog's own action buttons (toolbar read ${JSON.stringify(seededRow.armed)})`);
  check(seededRow.dialogClosed === true, 'placing from the dialog closes it, returning focus to the board');
  await s.eval(`window.__braAutoModeDebug.resetShapeStamps()`);
  await s.eval(`document.getElementById('toolsMenuBtn').click()`);
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  const toolsClosed = await s.eval(`({ hidden:document.getElementById('toolsMenuList').hidden,
    expanded:document.getElementById('toolsMenuBtn').getAttribute('aria-expanded'), focus:document.activeElement.id })`);
  check(toolsClosed.hidden && toolsClosed.expanded === 'false', 'Escape did not close Tools menu');
  check(toolsClosed.focus === 'toolsMenuBtn', `Escape should return focus to Tools trigger, got ${toolsClosed.focus}`);
  // Restore the default (POM Focus) state for every section below — a
  // second click of the same toggle, since Sketch Focus is still active here.
  await s.eval(`document.getElementById('sketchFocusBtn').click()`);
  console.log('board-toolbar-check: Tools drop-down holds all seven drawing tools, keyboard ok');

  // Add an offline fixture without invoking detection: this isolates the Auto
  // ready-state toolbar. Detection and Apply remain owned by smoke/golden.
  const autoReady = await s.eval(`(async () => {
    document.getElementById('modeAutoBtn').click();
    const fixture=document.createElement('canvas'); fixture.width=800; fixture.height=500;
    const fctx=fixture.getContext('2d'); fctx.fillStyle='#fff'; fctx.fillRect(0,0,fixture.width,fixture.height);
    fctx.strokeStyle='#111'; fctx.lineWidth=8; fctx.strokeRect(90,70,620,360);
    fctx.beginPath(); fctx.moveTo(120,420); fctx.bezierCurveTo(260,100,540,100,680,420); fctx.stroke();
    const dataURL = fixture.toDataURL('image/png');
    const result = await window.__braAutoModeDebug.addBoardImages([dataURL]);
    const visible = ${VISIBLE_BUTTONS};
    const primary = visible.filter(id => document.getElementById(id).classList.contains('context-primary'));
    return { status:result.status, imageCount:result.imageCount, visible, primary };
  })()`);
  check(autoReady.status === 'ready' && autoReady.imageCount === 1,
    `real Board image should reach Auto ready state, got ${JSON.stringify(autoReady)}`);
  check(autoReady.visible.includes('autoDetectBtn') && !autoReady.visible.includes('autoGenerateBtn'),
    'Auto ready should show Detect but not Generate');
  check(autoReady.primary.join(',') === 'autoDetectBtn', `Detect should be the only workflow primary, got ${autoReady.primary}`);
  console.log('board-toolbar-check: Auto ready ok');

  await s.eval(`document.getElementById('modeManualBtn').click()`);
  await s.waitFor(`!document.body.classList.contains('app-auto')`, 4000);
  const populatedManual = await s.eval(`({
    lineSettings: !document.querySelector('.board-line-settings').hidden,
    exportVisible: !document.getElementById('exportMenuWrap').hidden,
    contextHidden: document.getElementById('boardContextActions').hidden,
    contextButtons: Array.from(document.querySelectorAll('#boardContextActions button'))
      .filter(button => !button.hidden && button.getBoundingClientRect().width > 0).map(button => button.id),
    directUnits: Array.from(document.querySelectorAll('#boardToolbarGroups > :not(.toolbar-spacer)'))
      .filter(el => { const r=el.getBoundingClientRect(); return !el.hidden && getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0; }).length,
  })`);
  check(!populatedManual.lineSettings, 'image selection should hide irrelevant line settings');
  check(populatedManual.exportVisible, 'Export menu should return on a populated Manual Board');
  check(!populatedManual.contextHidden && populatedManual.contextButtons.includes('lockImageBtn')
      && populatedManual.contextButtons.includes('deleteBtn')
      && !populatedManual.contextButtons.includes('copyLineBtn'),
    `selected image should expose image actions only, got ${populatedManual.contextButtons}`);
  check(populatedManual.directUnits <= 7, `populated Manual should have at most 7 direct units, got ${populatedManual.directUnits}`);
  // Once a photo exists all seven tools must be reachable, Eraser included, and
  // choosing one from the menu has to drive the same setTool() path the direct
  // button used to — the drop-down is the only route a TD now has to them.
  await s.eval(`document.getElementById('toolsMenuBtn').click()`);
  const toolsPopulated = await s.eval(`${TOOL_MENU_ITEMS}
    .filter(button => !button.hidden && !button.disabled && button.offsetParent !== null).map(button => button.id)`);
  check(JSON.stringify(toolsPopulated) === JSON.stringify([
    'toolStraight', 'toolCurved', 'toolEraser', 'toolText', 'toolRectangle', 'toolCircle', 'toolHexagon',
  ]), `a populated Board must offer all seven drawing tools, got ${JSON.stringify(toolsPopulated)}`);
  await s.eval(`document.getElementById('toolStraight').click()`);
  const afterToolPick = await s.eval(`({
    menuClosed: document.getElementById('toolsMenuList').hidden,
    lineSettings: !document.querySelector('.board-line-settings').hidden,
    triggerLabel: document.getElementById('toolsMenuBtn').textContent,
  })`);
  check(afterToolPick.menuClosed, 'choosing a tool should close the Tools menu');
  check(afterToolPick.lineSettings, 'choosing a drawing tool should reveal line settings');
  check(afterToolPick.triggerLabel === 'Tools: Straight',
    `the Tools trigger should name the active tool, got ${JSON.stringify(afterToolPick.triggerLabel)}`);
  console.log('board-toolbar-check: populated Manual ok');

  // US-093 / ADR 0053 code review, 2026-08-21: the responsive loop below used
  // to run with an IMAGE selected and toolStraight active, which hides both
  // #toolAddPoint and #boardContextActions — so the widest state US-093
  // actually adds was never measured at any width. Draw a real curved line so
  // the loop can select it: that is the widest state a TD can reach, with the
  // context actions AND the selection-gated Add point tool both live.
  const widestSetup = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const w2s = (p) => { const v = d.getView(); const r = canvas.getBoundingClientRect();
      return { x: p.x * v.zoom + v.panX + r.left, y: p.y * v.zoom + v.panY + r.top }; };
    const ev = (t, x, y) => canvas.dispatchEvent(new MouseEvent(t, {
      bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons: t === 'mouseup' ? 0 : 1 }));
    const clickAt = (p) => { const q = w2s(p); ev('mousedown', q.x, q.y); ev('mouseup', q.x, q.y); };
    const im = d.getImages()[0];
    // A curved line takes THREE clicks (canvas-tools.js): start, a point it must
    // pass through, end.
    document.getElementById('toolCurved').click();
    clickAt({ x: im.x + im.width * 0.20, y: im.y + im.height * 0.30 });
    clickAt({ x: im.x + im.width * 0.45, y: im.y + im.height * 0.18 });
    clickAt({ x: im.x + im.width * 0.70, y: im.y + im.height * 0.35 });
    document.getElementById('toolSelect').click();
    const curved = d.getAnnotations().find(a => a.type === 'curved');
    return { drawn: !!curved, total: d.getAnnotations().length };
  })()`);
  check(widestSetup.drawn,
    `the responsive loop needs a real curved line to select; the three-click draw produced ${widestSetup.total} annotations`);

  // Responsive proof: no document-level horizontal overflow and no toolbar
  // element overlap at the target widths, in BOTH the widest selected state and
  // the authoring state. At 768 the Board strip may scroll horizontally, but it
  // must remain contained and usable.
  const PROBE = `(() => {
    const toolbar=document.querySelector('.toolbar').getBoundingClientRect();
    const groups=document.getElementById('boardToolbarGroups');
    const groupRect=groups.getBoundingClientRect();
    return { toolbarHeight:Math.round(toolbar.height), toolbarWidth:Math.round(toolbar.width),
      groupWidth:Math.round(groupRect.width), groupLeft:Math.round(groupRect.left), groupRight:Math.round(groupRect.right),
      documentWidth:document.documentElement.scrollWidth,
      pageOverflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
      groupsOverflow:groups.scrollWidth > groups.clientWidth,
      menuTrayRight:Math.round(document.querySelector('.board-menu-tray').getBoundingClientRect().right),
      viewport:document.documentElement.clientWidth,
      addPoint:!document.getElementById('toolAddPoint').hidden,
      contextActions:!document.getElementById('boardContextActions').hidden };
  })()`;
  for (const width of [1440, 1024, 768]) {
    await s.cdp('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false });
    await s.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))`);
    const states = await s.eval(`(() => {
      const d = window.__braAutoModeDebug;
      const canvas = document.getElementById('boardCanvas');
      const w2s = (p) => { const v = d.getView(); const r = canvas.getBoundingClientRect();
        return { x: p.x * v.zoom + v.panX + r.left, y: p.y * v.zoom + v.panY + r.top }; };
      const ev = (t, x, y) => canvas.dispatchEvent(new MouseEvent(t, {
        bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons: t === 'mouseup' ? 0 : 1 }));
      const clickAt = (p) => { const q = w2s(p); ev('mousedown', q.x, q.y); ev('mouseup', q.x, q.y); };
      const bez = (a, t) => { const u = 1 - t; return {
        x: u*u*u*a.start.x + 3*u*u*t*a.control1.x + 3*u*t*t*a.control2.x + t*t*t*a.end.x,
        y: u*u*u*a.start.y + 3*u*u*t*a.control1.y + 3*u*t*t*a.control2.y + t*t*t*a.end.y }; };
      const probe = () => ${PROBE};
      const im = d.getImages()[0];
      const curved = d.getAnnotations().find(a => a.type === 'curved');
      clickAt(bez(curved, 0.5));                       // widest: curve selected
      const widest = probe();
      clickAt({ x: im.x - 140, y: im.y - 140 });       // authoring: nothing selected
      const authoring = probe();
      clickAt(bez(curved, 0.5));                       // leave it selected for the next width
      return { widest, authoring };
    })()`);
    // Without this the loop could silently drift back to measuring a narrow
    // state — which is exactly how it stopped covering US-093's own chrome.
    check(states.widest.addPoint && states.widest.contextActions,
      `${width}px did not reach the widest state — Add point ${states.widest.addPoint}, context actions `
      + `${states.widest.contextActions}. The click meant to select the curve missed it, so this width proves nothing.`);
    for (const [label, layout] of [['widest (curved line selected)', states.widest], ['authoring', states.authoring]]) {
      check(!layout.pageOverflow, `${width}px ${label} created document-level horizontal overflow: ${JSON.stringify(layout)}`);
      check(layout.menuTrayRight <= layout.viewport + 1,
        `${width}px ${label} did not keep File/Export/More inside the viewport: ${JSON.stringify(layout)}`);
      if (width < 1024) {
        check(layout.groupsOverflow,
          `${width}px ${label} should keep the full Board toolbar available through contained horizontal scrolling: ${JSON.stringify(layout)}`);
      }
    }
    // The two-row budget is a claim about the AUTHORING row — TESTING.md's own
    // story for it is US-092's fifth tool taking that row from 96 px to 131 px
    // while the four tools still carried text labels. Measured 2026-08-21 on
    // this fixture: authoring is 95.5 px at 1440 (two rows) and 131 px at 1024,
    // so the guard belongs on the authoring probe, where re-adding those labels
    // still turns it red.
    if (width === 1440) {
      check(states.authoring.toolbarHeight < 115,
        `1440px toolbar exceeded two rows: ${states.authoring.toolbarHeight}px`);
    }
    // Selecting a line has always cost a wrapped row (that 35.5 px is the
    // ADR-0051 canvas shift board-interaction-check section 0 compensates for);
    // what must not regress is the SIZE of that cost. Measured 2026-08-21 with
    // a curved line selected: 1440 px 95.5 -> 131.0 (+35.5, one row), 1024 px
    // 131.0 -> 137.3 (+6.3), 768 px 97.5 -> 97.5 (+0, the strip scrolls instead
    // of wrapping). A second wrapped row would exceed 40 px and fail here.
    check(states.widest.toolbarHeight - states.authoring.toolbarHeight <= 40,
      `${width}px selecting a curved line grew the toolbar by `
      + `${states.widest.toolbarHeight - states.authoring.toolbarHeight}px (${states.authoring.toolbarHeight} -> `
      + `${states.widest.toolbarHeight}) — more than the one wrapped row this contextual toolbar is allowed`);
    console.log(`board-toolbar-check: ${width}px authoring ${states.authoring.toolbarHeight}px, `
      + `widest ${states.widest.toolbarHeight}px`);
  }
  await s.cdp('Emulation.clearDeviceMetricsOverride', {});
  console.log('board-toolbar-check: responsive ok');

  const errors = await s.cdp('Runtime.evaluate', { expression:`window.__toolbarConsoleErrors || []`, returnByValue:true });
  check(Array.isArray(errors.result.value) && errors.result.value.length === 0, 'toolbar run recorded console errors');

  await s.close();
  console.log(`PASS  board-toolbar-check   ${passed}/${passed} assertions ok`);
}

function check(condition, message) {
  if (!condition) {
    process.exitCode = 1;
    throw new Error(message);
  }
  passed += 1;
}

async function openCdpSession(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('no page target available');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once:true });
    ws.addEventListener('error', reject, { once:true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id:requestId, method, params }));
  });
  await cdp('Runtime.enable');
  await cdp('Runtime.evaluate', { expression:`window.__toolbarConsoleErrors=[]; addEventListener('error',e=>window.__toolbarConsoleErrors.push(String(e.message||e.error)))` });
  const evalJs = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'eval failed');
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await evalJs(expression)) return; } catch (_) {}
      await sleep(80);
    }
    throw new Error('waitFor timeout: ' + expression);
  };
  return { eval:evalJs, waitFor, cdp, close:() => ws.close() };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForCdp(port) {
  for (let i=0; i<80; i+=1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch (_) {}
    await sleep(80);
  }
  throw new Error('CDP did not come up');
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} ${response.status}`);
  return response.json();
}

try {
  await main();
} catch (error) {
  if (process.exitCode == null) process.exitCode = 1;
  console.error('FAIL', error && error.message ? error.message : error);
} finally {
  for (const task of cleanupTasks.reverse()) {
    try { await task(); } catch (_) {}
  }
}
