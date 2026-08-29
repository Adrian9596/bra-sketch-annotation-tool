#!/usr/bin/env node
// US-102: POM Focus / Sketch Focus — focused proof for the items board-
// toolbar-check and personal-library-check don't already cover: lifecycle
// resets (Auto transition, Open Project, autosave Restore), the export/
// live-canvas callout split, Command Palette exposure, panel auto-close,
// and Stamp/style cleanup on exit. POM Focus is the IMPLICIT default with no
// button of its own; the single control is `#sketchFocusBtn`, a toggle that
// enters Sketch Focus on the first click and returns to POM Focus on the
// second (2026-08-28 correction — the original two-button "POM/Sketch"
// segmented control is wrong). See docs/archive/stories/E01-manual-mode/
// US-102-sketch-mode-handoff.md and US-102-fix-checklist.md (archived
// 2026-08-29; superseded by docs/stories/epics/E01-manual-mode/
// US-102-sketch-mode.md) for the requirements this proves.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let server, chrome, userDataDir, passed = 0;
const cleanup = [];
const check = (ok, msg) => { if (!ok) throw new Error(msg); passed += 1; };

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanup.push(() => new Promise(r => server.close(r)));
  const port = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'sketch-focus-check-'));
  cleanup.push(() => rm(userDataDir, { recursive: true, force: true }).catch(() => {}));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--window-size=1366,900',
    `${started.baseUrl}/index.html?sketchfocus=${Date.now()}`]);
  cleanup.push(() => new Promise(r => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(port);
  const s = await session(port);
  await s.waitFor('window.__braAutoModeDebug && document.getElementById("modeManualBtn")', 8000);

  // 1: fresh Manual entry is POM Focus — no POM button exists at all, and the
  // single Sketch toggle starts inactive/aria-pressed=false.
  const freshManual = await s.eval(`(() => {
    document.getElementById('modeManualBtn').click();
    const btn = document.getElementById('sketchFocusBtn');
    return {
      sketchMode: window.__braAutoModeDebug.getState().sketchMode,
      noPomButton: document.getElementById('pomFocusBtn') === null,
      btnActive: btn.classList.contains('active'),
      btnPressed: btn.getAttribute('aria-pressed'),
      accessibleName: btn.getAttribute('aria-label') || btn.textContent.trim(),
      title: btn.title,
    };
  })()`);
  check(freshManual.sketchMode === false, 'a fresh Manual entry must start in POM Focus');
  check(freshManual.noPomButton, 'there must be no separate POM Focus button — POM Focus is the implicit default');
  check(freshManual.btnActive === false && freshManual.btnPressed === 'false',
    `the single Sketch toggle must start inactive/aria-pressed=false, got ${JSON.stringify(freshManual)}`);
  check(/Sketch Focus/.test(freshManual.accessibleName) && /return to POM Focus/i.test(freshManual.accessibleName),
    `the toggle's accessible name must say "Sketch Focus" and explain that releasing it returns to POM Focus, got ${JSON.stringify(freshManual.accessibleName)}`);
  check(/Sketch Focus/.test(freshManual.title),
    `the toggle's tooltip must say "Sketch Focus", got ${JSON.stringify(freshManual.title)}`);

  // 4: Command Palette exposes ONE toggle command, Manual-only, no shortcut.
  const commands = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const list = d.commands.list();
    const toggle = list.find(c => c.id === 'board.focus.sketch.toggle');
    const stalePom = list.find(c => c.id === 'board.focus.pom');
    const staleSketch = list.find(c => c.id === 'board.focus.sketch');
    return { toggle, stalePom, staleSketch, all: list.map(c => c.shortcut).filter(Boolean) };
  })()`);
  check(!!commands.toggle, 'board.focus.sketch.toggle must be a registered command');
  check(/Toggle Sketch Focus/i.test(commands.toggle.label), `the command label must be "Toggle Sketch Focus", got ${JSON.stringify(commands.toggle.label)}`);
  check(!commands.stalePom && !commands.staleSketch,
    'the old two-command board.focus.pom/board.focus.sketch pair must not exist alongside the new toggle');
  check(!commands.toggle.shortcut,
    'the focus toggle command may not carry a dedicated single-key shortcut (avoids a new collision risk)');
  check(commands.all.filter(sc => sc === commands.toggle.shortcut).length === 0,
    'no other command may collide with a (non-existent) focus toggle shortcut');

  // 5: entering Sketch Focus closes an open Measurements panel once; a TD
  // can still reopen it manually.
  const panel = await s.eval(`(() => {
    const el = { workspace: document.querySelector('.workspace') };
    // Ensure the panel starts OPEN regardless of prior test state.
    if (el.workspace.classList.contains('panel-hidden')) document.getElementById('togglePanelBtn').click();
    const openBefore = !el.workspace.classList.contains('panel-hidden');
    document.getElementById('sketchFocusBtn').click();
    const closedOnEntry = el.workspace.classList.contains('panel-hidden');
    document.getElementById('togglePanelBtn').click();
    const reopenedManually = !el.workspace.classList.contains('panel-hidden');
    return { openBefore, closedOnEntry, reopenedManually };
  })()`);
  check(panel.openBefore, 'precondition: the Measurements panel was open before entering Sketch Focus');
  check(panel.closedOnEntry, 'entering Sketch Focus must auto-close an open Measurements panel');
  check(panel.reopenedManually, 'a TD must still be able to reopen the Measurements panel by hand in Sketch Focus');
  await s.eval(`document.getElementById('sketchFocusBtn').click()`); // toggle back to POM Focus

  // 2 (partial — the rest is covered by board-toolbar-check's Tools-menu
  // section): the More menu is POM-Focus-only.
  const moreMenu = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const visible = () => document.getElementById('moreMenuWrap').offsetParent !== null;
    const pom = visible();
    document.getElementById('sketchFocusBtn').click();
    const sketch = visible();
    document.getElementById('sketchFocusBtn').click();
    const pomAgain = visible();
    return { pom, sketch, pomAgain };
  })()`);
  check(moreMenu.pom === true && moreMenu.sketch === false && moreMenu.pomAgain === true,
    `the More menu must show only in POM Focus, got ${JSON.stringify(moreMenu)}`);

  // 3: keyboard navigation in the Stitches menu differs correctly by focus
  // state (Tools menu's own End-key case is covered by board-toolbar-check).
  const stitches = await s.eval(`(() => {
    const reach = () => Array.from(document.querySelectorAll('#stitchesMenu [role="menuitem"], #stitchesMenu .style-option'))
      .filter(b => !b.hidden && b.offsetParent !== null).map(b => b.dataset ? b.dataset.style : null).filter(Boolean);
    document.getElementById('stitchesBtn').click();
    const pomStyles = reach();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('sketchFocusBtn').click();
    document.getElementById('stitchesBtn').click();
    const sketchStyles = reach();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('sketchFocusBtn').click();
    return { pomStyles, sketchStyles };
  })()`);
  check(JSON.stringify(stitches.pomStyles) === JSON.stringify(['solid', 'dashed']),
    `POM Focus must reach only solid/dashed, got ${JSON.stringify(stitches.pomStyles)}`);
  check(stitches.sketchStyles.includes('zigzag') && stitches.sketchStyles.includes('cover')
    && stitches.sketchStyles.includes('bartack') && stitches.sketchStyles.includes('solid'),
    `Sketch Focus must additionally reach zigzag/cover/bartack, got ${JSON.stringify(stitches.sketchStyles)}`);

  // 6: Sketch Focus hides the live callout WITHOUT touching POM geometry.
  // purpose must NOT be 'sketch-element' (US-098/ADR 0058) — that marks
  // Template/Scratch-Area geometry, which isMeasurementAnnotation excludes
  // unconditionally regardless of style, so it would never show a callout
  // either way and would prove nothing.
  const callout = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const pom = { id: 9601, seq: 6, type: 'straight', style: 'solid', color: 'red', arrowType: 'double',
      lineWidth: 2.5, start: { x: 1200, y: 0 }, end: { x: 1300, y: 0 },
      control1: null, control2: null, points: [], label: { x: 1250, y: -20 }, labelManual: false };
    d.styleEvidence.pushAnnotation(pom);
    const before = { shows: d.annotationShowsCallout(9601), geom: JSON.stringify(d.getAnnotations().find(a => a.id === 9601)) };
    document.getElementById('sketchFocusBtn').click();
    const during = { shows: d.annotationShowsCallout(9601), geom: JSON.stringify(d.getAnnotations().find(a => a.id === 9601)) };
    document.getElementById('sketchFocusBtn').click();
    const after = { shows: d.annotationShowsCallout(9601) };
    return { before, during, after };
  })()`);
  check(callout.before.shows === true, 'a real POM annotation must show its callout in POM Focus');
  check(callout.during.shows === false, 'Sketch Focus must hide the live callout');
  check(callout.during.geom === callout.before.geom, 'hiding the callout must not move or alter the POM line itself');
  check(callout.after.shows === true, 'returning to POM Focus must restore the callout');

  // 7: the export-shared gate (labelsVisible, read directly by export-pdf.js
  // and — through its shared drawBoardContentForExport — by Copy Image, the
  // Excel embedded sketch, and the Preview board sheet) must NOT change
  // because of Sketch Focus. This is the specific defect the handoff found:
  // an earlier version of labelsVisible() itself checked state.sketchMode,
  // which would have silently dropped POM numbers from every export made
  // while Sketch Focus happened to be on.
  const exportGate = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const pom = d.getState().sketchMode === false ? null : 'precondition failed';
    const before = d.labelsVisible();
    document.getElementById('sketchFocusBtn').click();
    const during = d.labelsVisible();
    document.getElementById('sketchFocusBtn').click();
    return { before, during };
  })()`);
  check(exportGate.before === true && exportGate.during === true,
    `labelsVisible (the export gate) must stay true regardless of Sketch Focus, got ${JSON.stringify(exportGate)}`);

  // 8 + 9: Sketch Focus -> Auto clears every focus effect; Auto -> Manual
  // (and a fresh Sketch Focus -> Auto -> Manual round trip) starts in POM
  // Focus VISUALLY (the single toggle's active/aria-pressed) as well as in
  // runtime state — setAppMode('auto') calls applySketchModeVisual, the SAME
  // sync path the toolbar button itself uses, specifically so it cannot
  // leave sketchFocusBtn showing active/aria-pressed=true while state has
  // moved on.
  const autoRoundTrip = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const buttonState = () => ({
      active: document.getElementById('sketchFocusBtn').classList.contains('active'),
      pressed: document.getElementById('sketchFocusBtn').getAttribute('aria-pressed'),
    });
    document.getElementById('sketchFocusBtn').click();
    const beforeAuto = { sketchMode: d.getState().sketchMode, bodyClass: document.body.classList.contains('sketch-mode-on'), button: buttonState() };
    document.getElementById('modeAutoBtn').click();
    const duringAuto = { sketchMode: d.getState().sketchMode, bodyClass: document.body.classList.contains('sketch-mode-on'), button: buttonState() };
    document.getElementById('modeManualBtn').click();
    const backInManual = { sketchMode: d.getState().sketchMode, button: buttonState() };
    return { beforeAuto, duringAuto, backInManual };
  })()`);
  check(autoRoundTrip.beforeAuto.sketchMode === true && autoRoundTrip.beforeAuto.bodyClass === true
    && autoRoundTrip.beforeAuto.button.active === true && autoRoundTrip.beforeAuto.button.pressed === 'true',
    `precondition: Sketch Focus was really on (state + button) before switching to Auto, got ${JSON.stringify(autoRoundTrip.beforeAuto)}`);
  check(autoRoundTrip.duringAuto.sketchMode === false && autoRoundTrip.duringAuto.bodyClass === false,
    'switching to Auto must clear sketchMode and the sketch-mode-on body class');
  check(autoRoundTrip.duringAuto.button.active === false && autoRoundTrip.duringAuto.button.pressed === 'false',
    `switching to Auto must also sync the toggle back to inactive/aria-pressed=false, got ${JSON.stringify(autoRoundTrip.duringAuto.button)}`);
  check(autoRoundTrip.backInManual.sketchMode === false,
    'returning from Auto to Manual must start in POM Focus');
  check(autoRoundTrip.backInManual.button.active === false,
    `returning to Manual must keep the toggle showing POM Focus (inactive), got ${JSON.stringify(autoRoundTrip.backInManual.button)}`);

  // 10 + 11: Open Project (and, by the same function, autosave Restore)
  // start in POM Focus; the saved project and undo history carry no focus
  // field at all (a live-authoring-only toggle, not project data).
  const persistence = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    document.getElementById('sketchFocusBtn').click();
    const snap = d.exportProject();
    const hasFocusField = Object.prototype.hasOwnProperty.call(snap.state, 'sketchMode');
    // Undo history: sketchMode must not be part of the snapshot restored by
    // Undo — make an annotation change (to have something to undo) with
    // Sketch Focus ON, then flip it off, then Undo, and confirm Undo did not
    // silently flip it back on (which is what it WOULD do if sketchMode were
    // captured in the history snapshot alongside the annotation).
    const pom = { id: 9602, seq: null, purpose: 'sketch-element', type: 'straight', style: 'solid', color: 'black',
      arrowType: 'none', lineWidth: 2, start: { x: 1400, y: 0 }, end: { x: 1500, y: 0 },
      control1: null, control2: null, points: [], label: { x: 1450, y: -20 }, labelManual: false };
    d.styleEvidence.pushAnnotation(pom);
    document.getElementById('sketchFocusBtn').click(); // toggle off, into POM Focus
    document.getElementById('undoBtn').click();
    await new Promise(r => setTimeout(r, 80));
    const sketchModeAfterUndo = d.getState().sketchMode;
    // Now prove the reopen-side of the lifecycle rule, including the
    // button: loadProject() calls applySketchModeVisual, the same
    // state+body-class+button-sync path the toolbar button itself uses, so a
    // reopen cannot leave sketchFocusBtn showing active/aria-pressed=true.
    document.getElementById('sketchFocusBtn').click(); // toggle on, into Sketch Focus
    const buttonBeforeReopen = { active: document.getElementById('sketchFocusBtn').classList.contains('active') };
    await d.loadProject(snap);
    const sketchModeAfterReopen = d.getState().sketchMode;
    const buttonAfterReopen = {
      active: document.getElementById('sketchFocusBtn').classList.contains('active'),
      pressed: document.getElementById('sketchFocusBtn').getAttribute('aria-pressed'),
    };
    return { hasFocusField, sketchModeAfterUndo, sketchModeAfterReopen, buttonBeforeReopen, buttonAfterReopen };
  })()`);
  check(persistence.hasFocusField === false,
    'exportProject() must not carry a sketchMode/focus field — it is live-authoring state, not project data');
  check(persistence.sketchModeAfterUndo === false,
    'Undo must not resurrect a focus state from before the undone change — sketchMode is not in the history snapshot');
  check(persistence.sketchModeAfterReopen === false,
    'reopening a project (Open Project, and by the same function, autosave Restore) must start in POM Focus');
  check(persistence.buttonBeforeReopen.active === true,
    'precondition: the Sketch toggle was really active before the reopen');
  check(persistence.buttonAfterReopen.active === false && persistence.buttonAfterReopen.pressed === 'false',
    `reopening a project must also sync the toggle back to inactive/aria-pressed=false, got ${JSON.stringify(persistence.buttonAfterReopen)}`);

  // 12: leaving Sketch Focus from an armed AND MID-DRAG Stamp clears the
  // tool, state.interaction, and activeStampId — not just a hand-set
  // state.tool. Arming alone (clicking a library row's "use" action) only
  // sets tool/activeStampId; the actual gesture record is
  // state.interaction.type === 'draw-stamp', created by pointer-events.js's
  // onMouseDown -> beginTrackedInteraction('draw-stamp', ...) on a REAL
  // mousedown on the canvas while the stamp tool is armed. A test that only
  // arms the tool and never starts that mousedown can never see interaction
  // go from non-null to null — it was already null — so it proves nothing
  // about interaction cleanup specifically. This dispatches a real mousedown
  // and deliberately withholds mouseup, matching "mid-drag" exactly.
  // Exit here is a second click of the same toggle.
  const stampCleanup = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, canvas = document.getElementById('boardCanvas');
    document.getElementById('sketchFocusBtn').click();
    d.importShapeStampsJson(JSON.stringify({ stamps: [{
      id: 'st-focus-fixture', name: 'Focus fixture', type: 'straight',
      start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, aspect: 1,
      style: 'solid', color: 'red', lineWidth: 2.5, arrowType: 'none',
    }] }));
    document.getElementById('toolsMenuBtn').click();
    const row = document.querySelector('#shapeStampList .preset-row[data-stamp-id="st-focus-fixture"] [data-stamp-action="use"]');
    row.click();
    const view = d.getView(), rect = canvas.getBoundingClientRect();
    const pt = { x: 60 * view.zoom + view.panX + rect.left, y: 60 * view.zoom + view.panY + rect.top };
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true, button: 0 }));
    const armed = { tool: d.getState().tool, activeStampId: d.getState().activeStampId, interaction: d.getState().interaction };
    document.getElementById('sketchFocusBtn').click(); // toggle off, into POM Focus, WITHOUT a mouseup first
    const cleared = { tool: d.getState().tool, activeStampId: d.getState().activeStampId, interaction: d.getState().interaction };
    d.resetShapeStamps();
    return { armed, cleared };
  })()`);
  check(stampCleanup.armed.tool === 'stamp' && stampCleanup.armed.activeStampId === 'st-focus-fixture'
    && stampCleanup.armed.interaction && stampCleanup.armed.interaction.type === 'draw-stamp',
    `precondition: a real mid-drag draw-stamp interaction exists before leaving Sketch Focus, got ${JSON.stringify(stampCleanup.armed)}`);
  check(stampCleanup.cleared.tool === 'select', 'leaving Sketch Focus must drop an armed Stamp tool back to Select');
  check(stampCleanup.cleared.activeStampId === null, 'leaving Sketch Focus must clear activeStampId, not just the tool');
  check(stampCleanup.cleared.interaction === null,
    `leaving Sketch Focus mid-drag must clear state.interaction, got ${JSON.stringify(stampCleanup.cleared.interaction)}`);

  // 12b: the same mid-drag armed-Stamp cleanup, but exiting via Auto —
  // setAppMode routes through setTool('select') specifically so activeStampId
  // does not survive (a raw state.tool assignment would leave it stale), and
  // separately clears state.interaction itself, because setTool does not
  // touch it (setTool's job is tool state, not gesture state).
  const stampCleanupAuto = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, canvas = document.getElementById('boardCanvas');
    document.getElementById('sketchFocusBtn').click();
    d.importShapeStampsJson(JSON.stringify({ stamps: [{
      id: 'st-focus-fixture-auto', name: 'Focus fixture auto', type: 'straight',
      start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, aspect: 1,
      style: 'solid', color: 'red', lineWidth: 2.5, arrowType: 'none',
    }] }));
    document.getElementById('toolsMenuBtn').click();
    const row = document.querySelector('#shapeStampList .preset-row[data-stamp-id="st-focus-fixture-auto"] [data-stamp-action="use"]');
    row.click();
    const view = d.getView(), rect = canvas.getBoundingClientRect();
    const pt = { x: 60 * view.zoom + view.panX + rect.left, y: 60 * view.zoom + view.panY + rect.top };
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true, button: 0 }));
    const armed = { tool: d.getState().tool, activeStampId: d.getState().activeStampId, sketchMode: d.getState().sketchMode, interaction: d.getState().interaction };
    document.getElementById('modeAutoBtn').click(); // no mouseup first — mid-drag
    const cleared = { tool: d.getState().tool, activeStampId: d.getState().activeStampId, interaction: d.getState().interaction };
    document.getElementById('modeManualBtn').click();
    document.getElementById('sketchFocusBtn').click(); // back to Sketch Focus for the next block
    d.resetShapeStamps();
    return { armed, cleared };
  })()`);
  check(stampCleanupAuto.armed.tool === 'stamp' && stampCleanupAuto.armed.activeStampId === 'st-focus-fixture-auto'
    && stampCleanupAuto.armed.sketchMode === true
    && stampCleanupAuto.armed.interaction && stampCleanupAuto.armed.interaction.type === 'draw-stamp',
    `precondition: a real mid-drag draw-stamp interaction exists in Sketch Focus before switching to Auto, got ${JSON.stringify(stampCleanupAuto.armed)}`);
  check(stampCleanupAuto.cleared.tool === 'select', 'switching to Auto must drop an armed Stamp tool back to Select');
  check(stampCleanupAuto.cleared.activeStampId === null, 'switching to Auto must clear activeStampId, not just the tool');
  check(stampCleanupAuto.cleared.interaction === null,
    `switching to Auto mid-drag must clear state.interaction, got ${JSON.stringify(stampCleanupAuto.cleared.interaction)}`);

  // 12c: the same mid-drag armed-Stamp cleanup, but exiting via Open Project —
  // the reopened project has nothing on its board for the old stamp to place.
  const stampCleanupOpenProject = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, canvas = document.getElementById('boardCanvas');
    const snap = d.exportProject();
    d.importShapeStampsJson(JSON.stringify({ stamps: [{
      id: 'st-focus-fixture-open', name: 'Focus fixture open', type: 'straight',
      start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, aspect: 1,
      style: 'solid', color: 'red', lineWidth: 2.5, arrowType: 'none',
    }] }));
    document.getElementById('toolsMenuBtn').click();
    const row = document.querySelector('#shapeStampList .preset-row[data-stamp-id="st-focus-fixture-open"] [data-stamp-action="use"]');
    row.click();
    const view = d.getView(), rect = canvas.getBoundingClientRect();
    const pt = { x: 60 * view.zoom + view.panX + rect.left, y: 60 * view.zoom + view.panY + rect.top };
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true, button: 0 }));
    const armed = { tool: d.getState().tool, activeStampId: d.getState().activeStampId, sketchMode: d.getState().sketchMode, interaction: d.getState().interaction };
    await d.loadProject(snap); // no mouseup first — mid-drag
    const cleared = { tool: d.getState().tool, activeStampId: d.getState().activeStampId, interaction: d.getState().interaction };
    d.resetShapeStamps();
    return { armed, cleared };
  })()`);
  check(stampCleanupOpenProject.armed.tool === 'stamp' && stampCleanupOpenProject.armed.activeStampId === 'st-focus-fixture-open'
    && stampCleanupOpenProject.armed.sketchMode === true
    && stampCleanupOpenProject.armed.interaction && stampCleanupOpenProject.armed.interaction.type === 'draw-stamp',
    `precondition: a real mid-drag draw-stamp interaction exists in Sketch Focus before Open Project, got ${JSON.stringify(stampCleanupOpenProject.armed)}`);
  check(stampCleanupOpenProject.cleared.tool === 'select', 'reopening a project must drop an armed Stamp tool back to Select');
  check(stampCleanupOpenProject.cleared.activeStampId === null,
    'reopening a project must clear activeStampId, not just the tool');
  check(stampCleanupOpenProject.cleared.interaction === null,
    `reopening a project mid-drag must clear state.interaction, got ${JSON.stringify(stampCleanupOpenProject.cleared.interaction)}`);

  // 13: leaving Sketch Focus resets only the PENDING (unselected) stitch
  // draw style — never restyles an existing/selected annotation.
  const styleCleanup = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('sketchFocusBtn').click();
    const existing = { id: 9603, seq: null, purpose: 'sketch-element', type: 'straight', style: 'zigzag', color: 'black',
      arrowType: 'none', lineWidth: 2, start: { x: 1600, y: 0 }, end: { x: 1700, y: 0 },
      control1: null, control2: null, points: [], label: { x: 1650, y: -20 }, labelManual: false };
    d.styleEvidence.pushAnnotation(existing);
    document.querySelector('[data-style="zigzag"]').click(); // sets the PENDING draw style
    const pendingBefore = d.getState().drawStyle;
    document.getElementById('sketchFocusBtn').click(); // toggle off, into POM Focus
    const pendingAfter = d.getState().drawStyle;
    const existingStyleAfter = d.getAnnotations().find(a => a.id === 9603).style;
    return { pendingBefore, pendingAfter, existingStyleAfter };
  })()`);
  check(styleCleanup.pendingBefore === 'zigzag', 'precondition: the pending draw style was really zigzag before leaving');
  check(styleCleanup.pendingAfter === 'solid', 'leaving Sketch Focus must reset the pending draw style to solid');
  check(styleCleanup.existingStyleAfter === 'zigzag',
    'leaving Sketch Focus must NOT restyle an existing annotation that already carries a stitch style');

  const errors = await s.eval('window.__sketchFocusErrors || []');
  check(errors.length === 0, 'browser console errors: ' + errors.join(' | '));
  await s.close();
  console.log(`PASS  sketch-focus-check   ${passed}/${passed} assertions ok`);
}

async function session(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const t = targets.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const cdp = (method, params = {}) => new Promise((r, j) => {
    const n = ++id;
    pending.set(n, m => m.error ? j(new Error(m.error.message)) : r(m.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await cdp('Runtime.enable');
  await cdp('Runtime.evaluate', {
    expression: `window.__sketchFocusErrors=[];addEventListener('error',e=>window.__sketchFocusErrors.push(String(e.message||e.error)))`,
  });
  const evalJs = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    eval: evalJs,
    waitFor: async (q, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (await evalJs(q)) return; } catch { /* retry */ } await sleep(80); }
      throw new Error('timeout ' + q);
    },
    close: () => ws.close(),
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForCdp(port) {
  for (let i = 0; i < 100; i += 1) { try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch { /* retry */ } await sleep(80); }
  throw new Error('CDP did not start');
}
async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

try { await main(); } catch (e) { process.exitCode = 1; console.error('FAIL', e.message); }
finally { for (const task of cleanup.reverse()) try { await task(); } catch { /* best effort */ } }
