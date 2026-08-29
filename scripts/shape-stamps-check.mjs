#!/usr/bin/env node
// US-097 / ADR 0056: the shape-stamp library.
//
// The claim is GEOMETRIC — "the shape that comes back is the shape that was
// saved, at the size that was asked for" — and that is exactly what a
// state-shaped assertion proves badly. `points.length === 3` and "the
// annotation exists" both pass for a curve rebuilt inside out, mirrored, or
// flattened to its chord, which are the three ways a normalize/denormalize
// pair actually fails.
//
// So the suite compares SHAPES: both curves are sampled at equal arc length and
// normalized into their own bounding boxes, so a stamp placed at 3x its source
// must still be *similar* to it, not merely present. Equal arc length, not
// equal index: two renderings of one curve at different sizes get different
// chord counts, and an index-wise comparison drifts even when the shape is
// identical.
//
// Deliberately independent of demo/: the fixture image is generated in-page.
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
const pageErrors = [];

const ERROR_TRAP = String.raw`
window.__ssErrors = window.__ssErrors || [];
if (!window.__ssTrapInstalled) {
  window.__ssTrapInstalled = true;
  window.addEventListener('error', e => window.__ssErrors.push(String(e.message || e.type)));
  window.addEventListener('unhandledrejection', e => window.__ssErrors.push(
    'unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)));
}
'trapped'`;

const HARNESS = String.raw`
window.__SS = (() => {
  const d = window.__braAutoModeDebug;
  const canvas = document.getElementById('boardCanvas');
  // Plain timers, not requestAnimationFrame: a hidden or backgrounded tab
  // suspends rAF and a settle built on it parks forever.
  const settle = () => new Promise(r => setTimeout(r, 130));
  const toClient = (wx, wy) => {
    const v = d.getView();
    const r = canvas.getBoundingClientRect();
    return { x: wx * v.zoom + v.panX + r.left, y: wy * v.zoom + v.panY + r.top };
  };
  const mouse = (type, wx, wy, target, init) => {
    const p = toClient(wx, wy);
    (target || canvas).dispatchEvent(new MouseEvent(type, Object.assign({
      clientX: p.x, clientY: p.y, bubbles: true, button: 0,
    }, init || {})));
  };
  const click = async (wx, wy, init) => {
    mouse('mousedown', wx, wy, null, init);
    mouse('mouseup', wx, wy, window, init);
    await settle();
  };
  const drag = async (x1, y1, x2, y2, init) => {
    mouse('mousedown', x1, y1, null, init);
    mouse('mousemove', (x1 + x2) / 2, (y1 + y2) / 2, null, init);
    mouse('mousemove', x2, y2, null, init);
    mouse('mouseup', x2, y2, window, init);
    await settle();
  };
  const openTools = async () => {
    const list = document.getElementById('toolsMenuList');
    if (list.hidden) document.getElementById('toolsMenuBtn').click();
    await settle();
  };
  const stampRow = (name) => Array.from(document.querySelectorAll('#shapeStampList .preset-row'))
    .find(r => r.textContent.indexOf(name.slice(0, 12)) !== -1);
  // Largest normalized distance between two sampled shapes. 0 = identical.
  const shapeDeviation = (a, b) => {
    if (!a || !b || a.points.length !== b.points.length) return Infinity;
    let worst = 0;
    for (let i = 0; i < a.points.length; i += 1) {
      worst = Math.max(worst, Math.hypot(a.points[i].x - b.points[i].x, a.points[i].y - b.points[i].y));
    }
    return worst;
  };
  // Count pixels of the line colour inside a world rect. The fixture sketch is
  // opaque white, so an alpha test would count the backdrop and every window
  // would come back full.
  const redCount = (worldRect) => {
    const v = d.getView();
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const x = Math.round((worldRect.x * v.zoom + v.panX) * dpr);
    const y = Math.round((worldRect.y * v.zoom + v.panY) * dpr);
    const w = Math.max(1, Math.round(worldRect.width * v.zoom * dpr));
    const h = Math.max(1, Math.round(worldRect.height * v.zoom * dpr));
    if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) return -1;
    const data = canvas.getContext('2d').getImageData(x, y, w, h).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - 230) <= 60 && Math.abs(data[i + 1] - 57) <= 60
        && Math.abs(data[i + 2] - 57) <= 60 && data[i + 3] > 120) n += 1;
    }
    return n;
  };
  const solidImage = (cssColor, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = cssColor; g.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  };
  return { d, settle, click, drag, openTools, stampRow, shapeDeviation, solidImage, toClient, mouse, redCount };
})();
'ready'`;

// Drain the page's error buffer into the node-side accumulator BEFORE the
// reload wipes it — reading only at the end would gate just the last page
// lifetime, the gap the US-096 suite was caught with.
async function reloadKeepingErrors(s, trap) {
  pageErrors.push(...(await s.eval(`window.__ssErrors || []`)));
  await s.eval(`window.location.reload()`);
  await s.waitFor(`!!window.__braAutoModeDebug`, 20000);
  await s.eval(trap);
  // A reload also wipes window.__SS. Re-installing it here rather than in each
  // caller is what lets sections after the reload block keep driving the app —
  // the first version of section 12 died on a destructure of undefined.
  await s.eval(HARNESS);
}

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'shape-stamps-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    // A RECOGNIZED test query param, or a view-role prompt can block the run
    // and the harness hangs instead of failing.
    `${started.baseUrl}/index.html?contract=shapestamps${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`!!window.__braAutoModeDebug`, 20000);
  check(await s.eval(ERROR_TRAP) === 'trapped', 'the page-error trap did not install');

  const served = await s.eval(`(async () => {
    const src = document.querySelector('script[src*="app.js"]').getAttribute('src');
    const txt = await (await fetch(src)).text();
    const d = window.__braAutoModeDebug;
    return {
      src,
      model: txt.includes('function shapeStampFromAnnotation'),
      place: txt.includes('function placeShapeStamp'),
      denorm: txt.includes('function denormalizeStampPoint'),
      preview: txt.includes('function drawShapeStampPreview'),
      sharedStore: txt.includes('function readLibraryStore'),
      panel: txt.includes('function renderShapeStampList'),
      getShapeStamps: typeof d.getShapeStamps === 'function',
      sampleShape: typeof d.sampleAnnotationShape === 'function',
      listInToolsMenu: !!document.querySelector('#toolsMenuList #shapeStampList'),
      saveInToolsMenu: !!document.querySelector('#toolsMenuList #shapeStampSaveBtn'),
    };
  })()`);
  for (const key of Object.keys(served)) {
    if (key === 'src') continue;
    check(served[key] === true, `the served bundle (${served.src}) predates US-097 — no ${key}. Run npm run build.`);
  }
  check(await s.eval(HARNESS) === 'ready', 'harness did not install');
  await s.eval(`window.__braAutoModeDebug.learning.setEnabled(false)`);
  await s.eval(`window.__braAutoModeDebug.resetShapeStamps()`);

  // ---- Setup: one sketch, Manual Mode, one bowed curve ----------------------
  const setup = await s.eval(`(async () => {
    const { d, settle, click, solidImage } = window.__SS;
    await d.addBoardImages([solidImage('#ffffff', 700, 460)]);
    document.getElementById('modeManualBtn').click();
    await settle();
    // US-102: Templates (the Shape Stamp / Tools-menu library this whole
    // suite exercises) are Sketch-Focus-only UI (.sketch-mode-only in
    // index.html) — #shapeStampList sits display:none in the POM-Focus
    // default. A synthetic .click() on a hidden row control still fires (it
    // bypasses visibility), so every list mutation in this suite passed
    // regardless, but a hidden element cannot receive real focus: the keyed
    // reorder's own refocusLibraryRowControl call (shape-stamp-panel.js)
    // silently failed and left focus on whatever tool button was clicked
    // last. Entering Sketch Focus once, for the whole suite, makes the list
    // actually visible so its focus-restoration behavior is exercised for
    // real, not skipped.
    document.getElementById('sketchFocusBtn').click();
    await settle();
    const img = d.getImages()[0];
    // A curve, drawn the normal way: start, a middle point it must pass
    // through, end. The middle click is what gives it a bow to preserve.
    document.getElementById('toolsMenuBtn').click();
    await settle();
    document.getElementById('toolCurved').click();
    await settle();
    await click(img.x + img.width * 0.15, img.y + img.height * 0.55);
    await click(img.x + img.width * 0.38, img.y + img.height * 0.20);
    await click(img.x + img.width * 0.70, img.y + img.height * 0.60);
    document.getElementById('toolSelect').click();
    await settle();
    const anns = d.getAnnotations();
    const curve = anns[anns.length - 1];
    return { img, curveId: curve.id, type: curve.type, seq: curve.seq,
      shape: d.sampleAnnotationShape(curve.id, 48) };
  })()`);
  check(setup.type === 'curved', `precondition: a curved line was drawn (got ${setup.type})`);
  check(setup.shape && setup.shape.aspect > 0.05,
    `precondition: the curve has a real bow to preserve (aspect ${setup.shape && setup.shape.aspect})`);

  // ---- 1. Save requires exactly one line, and keeps no identity ------------
  const saved = await s.eval(`(async () => {
    const { d, settle, click, openTools } = window.__SS;
    const img = d.getImages()[0];
    const curve = d.getAnnotations().find(a => a.id === ${setup.curveId});
    // A second line, so a two-line selection can be refused.
    document.getElementById('toolsMenuBtn').click(); await settle();
    document.getElementById('toolStraight').click(); await settle();
    await click(img.x + 20, img.y + img.height - 20);
    await click(img.x + 80, img.y + img.height - 20);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('toolSelect').click(); await settle();
    const other = d.getAnnotations()[d.getAnnotations().length - 1];

    // Two selected -> one reusable Template.
    await click(curve.start.x, curve.start.y);
    await click(other.start.x, other.start.y, { shiftKey: true });
    await openTools();
    document.getElementById('shapeStampSaveBtn').click();
    await settle();
    const multiDialog = document.querySelector('.picker-overlay');
    const multiInput = multiDialog && multiDialog.querySelector('input[type="text"]');
    if (multiInput) {
      multiInput.value = 'Two path Template';
      multiInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    await settle();
    const multiTemplate = d.getShapeStamps()[0] || null;
    d.resetShapeStamps();

    // One selected -> save. Collapse the group first: a plain click on a line
    // that is already IN the group keeps the group, which is the whole point of
    // Shift-select and would leave this still refusing.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    await click(curve.start.x, curve.start.y);
    await settle();
    const selectedForSave = d.getState().selection;
    await openTools();
    document.getElementById('shapeStampSaveBtn').click();
    await settle();
    const dialog = document.querySelector('.picker-overlay');
    const input = dialog && dialog.querySelector('input[type="text"]');
    if (input) {
      input.value = 'Cup bottom curve';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    await settle();
    const stamps = d.getShapeStamps();
    return {
      multiDialogOpened: !!multiDialog, multiTemplate, otherId: other.id, selectedForSave,
      dialogOpened: !!dialog,
      count: stamps.length, stamp: stamps[0] || null,
    };
  })()`);
  check(saved.multiDialogOpened === true
    && saved.multiTemplate && saved.multiTemplate.members.length === 2,
    `a two-line selection saves one editable two-member Template `
    + `(dialog ${saved.multiDialogOpened}, template ${JSON.stringify(saved.multiTemplate)})`);
  check(saved.selectedForSave && saved.selectedForSave.kind === 'annotation'
    && saved.selectedForSave.id === setup.curveId,
    `precondition: exactly the curve is selected for the save `
    + `(got ${JSON.stringify(saved.selectedForSave)}, wanted id ${setup.curveId})`);
  check(saved.dialogOpened === true, 'one selected line opens the name dialog');
  check(saved.count === 1 && saved.stamp && saved.stamp.name === 'Cup bottom curve',
    `one selected line saves (got ${saved.count} stamp(s))`);
  const stamp = saved.stamp;
  check(stamp.type === 'curved' && stamp.control1 && stamp.control2,
    'the saved stamp is a curve with both control points');
  for (const [key, point] of [['start', stamp.start], ['end', stamp.end],
    ['control1', stamp.control1], ['control2', stamp.control2]]) {
    check(point.x >= -0.001 && point.x <= 1.001 && point.y >= -0.001 && point.y <= 1.001,
      `${key} is normalized into the unit box — an absolute coordinate here would make the `
      + `stamp unusable on any other sketch (got ${JSON.stringify(point)})`);
  }
  for (const forbidden of ['seq', 'text', 'sourceImageId', 'measureScale', 'value', 'id2']) {
    if (forbidden === 'id2') continue;
    check(!(forbidden in stamp),
      `a stamp must not carry the source line's ${forbidden} — a POM number is an identity, `
      + `not a look, and stamping the same curve twice would put two lines on one POM`);
  }

  // ---- 2. The shape survives placement at very different sizes -------------
  const placed = await s.eval(`(async () => {
    const { d, settle, drag, openTools, stampRow, shapeDeviation } = window.__SS;
    const img = d.getImages()[0];
    await openTools();
    const row = stampRow('Cup bottom curve');
    const armedFromRow = !!row;
    if (row) row.querySelector('[data-stamp-action="use"]').click();
    await settle();
    const statusNamesStamp = document.getElementById('toolStatus').textContent.indexOf('Cup bottom curve') !== -1;

    // Small, aspect locked with Shift.
    await drag(img.x + img.width * 0.05, img.y + img.height * 0.62,
      img.x + img.width * 0.28, img.y + img.height * 0.95, { shiftKey: true });
    const small = d.getAnnotations()[d.getAnnotations().length - 1];
    // Large, aspect locked with Shift.
    await drag(img.x + img.width * 0.35, img.y + img.height * 0.05,
      img.x + img.width * 0.98, img.y + img.height * 0.95, { shiftKey: true });
    const big = d.getAnnotations()[d.getAnnotations().length - 1];

    const src = d.sampleAnnotationShape(${setup.curveId}, 48);
    const a = d.sampleAnnotationShape(small.id, 48);
    const b = d.sampleAnnotationShape(big.id, 48);
    return {
      armedFromRow, statusNamesStamp,
      smallId: small.id, bigId: big.id,
      srcSize: [src.width, src.height], smallSize: [a.width, a.height], bigSize: [b.width, b.height],
      devSmall: shapeDeviation(src, a), devBig: shapeDeviation(src, b),
      // A chord would score ~0 against itself, so prove the source is not one.
      devAgainstChord: shapeDeviation(src, { points: src.points.map((p, i) => ({ x: i / (src.points.length - 1), y: 0.5 })) }),
      seqs: [small.seq, big.seq],
      purposes: [small.purpose, big.purpose],
      measured: [small, big].map(x => d.getMeasurementAnnIds().includes(x.id)),
      owners: [small.sourceImageId, big.sourceImageId], imgId: img.id,
      texts: [small.text, big.text],
      styles: [small.style, big.style],
      anchors: [(small.points || []).length, (big.points || []).length],
    };
  })()`);
  check(placed.armedFromRow === true && placed.statusNamesStamp === true,
    'picking a stamp from the Tools menu arms it and the status bar names it');
  check(placed.bigSize[0] / placed.smallSize[0] > 2,
    `precondition: the two placements really are different sizes `
    + `(${Math.round(placed.smallSize[0])} vs ${Math.round(placed.bigSize[0])} wide) — `
    + `same-size placements would make the shape comparison trivial`);
  check(placed.devAgainstChord > 0.05,
    `precondition: the source curve is meaningfully bowed, so "shapes match" is not `
    + `satisfied by any straight line (chord deviation ${placed.devAgainstChord.toFixed(4)})`);
  check(placed.devSmall < 0.02,
    `a stamp placed SMALL keeps its source's shape (worst normalized deviation `
    + `${placed.devSmall.toFixed(4)}, tolerance 0.02)`);
  check(placed.devBig < 0.02,
    `a stamp placed LARGE keeps its source's shape (worst normalized deviation `
    + `${placed.devBig.toFixed(4)}, tolerance 0.02)`);
  check(placed.purposes.every(x => x === 'sketch-element')
    && placed.measured.every(x => x === false),
    `Template placements are Sketch Elements, not automatic POMs `
    + `(purpose ${JSON.stringify(placed.purposes)}, measured ${JSON.stringify(placed.measured)})`);
  check(placed.texts[0] === null && placed.texts[1] === null,
    `a placed line inherits no POM label from the source (got ${JSON.stringify(placed.texts)})`);
  check(placed.owners[0] === placed.imgId && placed.owners[1] === placed.imgId,
    `a stamp placed over a sketch is owned by it, so it moves and scales with it `
    + `(got ${JSON.stringify(placed.owners)}, image ${placed.imgId})`);

  // ---- 2b. A FREE drag gives the dragged box, distortion included ----------
  //
  // Added 2026-08-23 after an adversarial audit found a HIGH defect the suite
  // could not see: normalizeStampBox floored the height at width * aspect on
  // EVERY placement, so a free drag could never place a stamp flatter than it
  // was saved, Shift was a no-op across that whole regime, and the extra height
  // was added below the drag rather than around it. Both size-fidelity drags
  // above pass shiftKey, where the floor is a no-op by construction — which is
  // exactly why the gap existed.
  const freeDrag = await s.eval(`(async () => {
    const { d, settle, drag, openTools, stampRow } = window.__SS;
    const img = d.getImages()[0];
    const stamp = d.getShapeStamps().find(x => x.name === 'Cup bottom curve');
    await openTools();
    stampRow('Cup bottom curve').querySelector('[data-stamp-action="use"]').click();
    await settle();
    // Deliberately FLATTER than the saved aspect, and with no Shift.
    const w = img.width * 0.5;
    const h = w * stamp.aspect * 0.35;
    const x1 = img.x + img.width * 0.05, y1 = img.y + img.height * 0.30;
    await drag(x1, y1, x1 + w, y1 + h);
    const placed = d.getAnnotations()[d.getAnnotations().length - 1];
    const shape = d.sampleAnnotationShape(placed.id, 32);
    // Where did it actually land? The sampled bbox is the drawn extent, so its
    // top edge is what moves when a box is inflated downward.
    let minY = Infinity, maxY = -Infinity, minX = Infinity;
    const poly = [placed.start, placed.end, placed.control1, placed.control2].filter(Boolean);
    for (const p of poly) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.x < minX) minX = p.x;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    const src = d.sampleAnnotationShape(${setup.curveId}, 32);
    return {
      savedAspect: stamp.aspect,
      squashFactor: 0.35,
      askedFor: { w, h, x1, y1 },
      got: { w: shape.width, h: shape.height, aspect: shape.aspect },
      srcDrawnAspect: src.aspect,
      topEdge: minY, leftEdge: minX,
    };
  })()`);
  check(freeDrag.got.w > 1,
    `precondition: the free drag placed something (got ${JSON.stringify(freeDrag.got)})`);
  // Compared as a RATIO against the source's own DRAWN aspect, not against the
  // dragged box. sampleAnnotationShape measures the painted extent, and a
  // curve's control points sit inside its box, so the drawn height is always
  // smaller than the box height — comparing the two directly is an apples-to-
  // oranges test that fails on correct code.
  const wantedAspect = freeDrag.srcDrawnAspect * freeDrag.squashFactor;
  check(freeDrag.got.aspect < freeDrag.srcDrawnAspect * 0.6,
    `a FREE drag must place the box that was dragged, flatter than the saved shape included `
    + `— the drag asked for ${(freeDrag.squashFactor * 100).toFixed(0)}% of the saved `
    + `proportion, but the placement came out at `
    + `${(freeDrag.got.aspect / freeDrag.srcDrawnAspect * 100).toFixed(0)}% of it. Flooring the `
    + `height at width*aspect turns Shift into a no-op and makes the shape unsquashable`);
  check(Math.abs(freeDrag.got.aspect - wantedAspect) < wantedAspect * 0.2,
    `...squashed by the amount that was dragged (wanted a drawn aspect of `
    + `${wantedAspect.toFixed(3)}, got ${freeDrag.got.aspect.toFixed(3)})`);
  // NOTE: an assertion that the drawn shape starts at or below the drag's top
  // edge is true by construction — every stamp point is normalized against the
  // bounds of that same point set, so denormalize can only produce y >= box.y.
  // It was in the first version of this section and could not fail. The
  // centre-growth half of the fix is covered by 2d below instead, which
  // actually reaches the minSide branch.


  // ---- 2d. A drag with (almost) no height still places a usable line -------
  //
  // The only path into normalizeStampBox's minSide branch, and therefore the
  // only test of the half of that fix that grows the box about its CENTRE
  // rather than its origin. Every other drag in this suite is tens of world
  // units tall, so both `if` bodies were dead across the whole run.
  const flatDrag = await s.eval(`(async () => {
    const { d, settle, drag, openTools, stampRow } = window.__SS;
    const img = d.getImages()[0];
    await openTools();
    stampRow('Cup bottom curve').querySelector('[data-stamp-action="use"]').click();
    await settle();
    const y = img.y + img.height * 0.44;
    const x1 = img.x + img.width * 0.05;
    const w = img.width * 0.45;
    // Height ZERO: a perfectly horizontal drag, which is what a TD does when
    // they want the flattest possible version of a curve.
    await drag(x1, y, x1 + w, y);
    const placed = d.getAnnotations()[d.getAnnotations().length - 1];
    const shape = d.sampleAnnotationShape(placed.id, 32);
    const ys = [placed.start, placed.end, placed.control1, placed.control2]
      .filter(Boolean).map(p => p.y);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    return {
      dragY: y, zoom: d.getView().zoom,
      minSide: 4 / d.getView().zoom,
      width: shape.width, height: shape.height,
      top: Math.min(...ys), bottom: Math.max(...ys),
      finite: ys.every(Number.isFinite),
    };
  })()`);
  check(flatDrag.finite === true, 'a zero-height drag still produces finite geometry');
  check(flatDrag.width > 1,
    `precondition: the flat drag placed a line of real width (got ${flatDrag.width.toFixed(1)})`);
  check(flatDrag.bottom - flatDrag.top <= flatDrag.minSide + 0.51,
    `a zero-height drag is raised only to the minimum, not to the saved aspect `
    + `(box height would be ${flatDrag.minSide.toFixed(2)}, shape spans `
    + `${(flatDrag.bottom - flatDrag.top).toFixed(2)})`);
  // The centre-growth claim: the raised box must straddle the drag line, not
  // hang below it. Origin growth would put the whole shape under dragY.
  const centre = (flatDrag.top + flatDrag.bottom) / 2;
  // Tolerance must be well under minSide/2: ORIGIN growth puts the centre
  // exactly minSide/2 below the drag, so anything looser passes for the very
  // bug this asserts against. (The first version used 0.75 and did.)
  check(Math.abs(centre - flatDrag.dragY) <= flatDrag.minSide * 0.2,
    `...and the minimum is applied about the box's CENTRE, so the line stays on the drag `
    + `rather than hanging below it. Origin growth would centre it `
    + `${(flatDrag.minSide / 2).toFixed(2)} below (dragged at y ${flatDrag.dragY.toFixed(2)}, `
    + `shape centred at ${centre.toFixed(2)}, minimum ${flatDrag.minSide.toFixed(2)})`);

  // ---- 2c. Shift with a near-VERTICAL drag ---------------------------------
  //
  // The aspect lock used to derive the height from |dx| alone, so a drag
  // straight down collapsed the whole box to nothing and the placement fell
  // through to the click path — a default-size stamp at the press point, which
  // is not what a 400px drag asked for.
  const verticalShift = await s.eval(`(async () => {
    const { d, settle, drag, openTools, stampRow } = window.__SS;
    const img = d.getImages()[0];
    const stamp = d.getShapeStamps().find(x => x.name === 'Cup bottom curve');
    await openTools();
    stampRow('Cup bottom curve').querySelector('[data-stamp-action="use"]').click();
    await settle();
    const x1 = img.x + img.width * 0.60, y1 = img.y + img.height * 0.05;
    const dyWanted = img.height * 0.55;
    // 3 world px of horizontal wander over a long vertical travel.
    await drag(x1, y1, x1 + 3, y1 + dyWanted, { shiftKey: true });
    const placed = d.getAnnotations()[d.getAnnotations().length - 1];
    const shape = d.sampleAnnotationShape(placed.id, 32);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    const src = d.sampleAnnotationShape(${setup.curveId}, 32);
    return { dyWanted, got: { w: shape.width, h: shape.height, aspect: shape.aspect },
      savedAspect: stamp.aspect, srcDrawnAspect: src.aspect,
      defaultWidth: img.width * 0.3 };
  })()`);
  check(verticalShift.got.h > verticalShift.dyWanted * 0.6,
    `Shift + a near-vertical drag must lock to the aspect using the axis actually dragged — `
    + `the drag travelled ${verticalShift.dyWanted.toFixed(0)} world px down but the placement `
    + `is only ${verticalShift.got.h.toFixed(0)} tall. Deriving the lock from |dx| alone `
    + `collapses the box and silently falls through to the default-size click path`);
  // Again the DRAWN aspect, not the box aspect: the two differ by a constant
  // factor for any curve whose controls sit inside its box, and the source's
  // own drawn aspect is what a Shift-locked placement should reproduce.
  check(Math.abs(verticalShift.got.aspect - verticalShift.srcDrawnAspect)
    < verticalShift.srcDrawnAspect * 0.12,
    `...and still honours the saved proportion (source draws at `
    + `${verticalShift.srcDrawnAspect.toFixed(3)}, placement at `
    + `${verticalShift.got.aspect.toFixed(3)})`);

  // ---- 3. A click places the default size, not nothing ---------------------
  const clicked = await s.eval(`(async () => {
    const { d, settle, click, openTools, stampRow } = window.__SS;
    const img = d.getImages()[0];
    // Sections 2b/2c end with Escape, which disarms. Re-arm explicitly rather
    // than relying on what an earlier section happened to leave behind.
    await openTools();
    stampRow('Cup bottom curve').querySelector('[data-stamp-action="use"]').click();
    await settle();
    const before = d.getAnnotations().length;
    await click(img.x + img.width * 0.5, img.y + img.height * 0.5);
    const after = d.getAnnotations();
    if (after.length === before) return { created: false };
    const placed = after[after.length - 1];
    const shape = d.sampleAnnotationShape(placed.id, 32);
    return {
      created: true,
      widthFraction: shape.width / img.width,
      owner: placed.sourceImageId, imgId: img.id,
      stillArmed: document.getElementById('toolStatus').textContent.indexOf('Cup bottom curve') !== -1,
    };
  })()`);
  check(clicked.created === true,
    'a press below the drag threshold places the stamp at a default size rather than '
    + 'creating nothing — the TD has already chosen the shape, so a click that produces '
    + 'nothing reads as a broken tool (deliberate divergence from ADR 0054)');
  check(Math.abs(clicked.widthFraction - 0.3) < 0.06,
    `...sized to 30% of the sketch it lands on (got ${(clicked.widthFraction * 100).toFixed(1)}%)`);
  check(clicked.stillArmed === true,
    'the tool stays armed after a placement — stamping the same curve on front and back '
    + 'is the common case');

  // ---- 4. Escape disarms ---------------------------------------------------
  const escaped = await s.eval(`(async () => {
    const { d, settle, click } = window.__SS;
    const img = d.getImages()[0];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    const before = d.getAnnotations().length;
    await click(img.x + img.width * 0.45, img.y + img.height * 0.4);
    return {
      disarmed: document.getElementById('toolStatus').textContent.indexOf('Cup bottom curve') === -1,
      placedAnyway: d.getAnnotations().length !== before,
    };
  })()`);
  check(escaped.disarmed === true, 'Escape leaves the stamp tool');
  check(escaped.placedAnyway === false,
    'and a press afterwards places nothing — a disarmed tool must not keep stamping');

  // ---- 5. The look travels, and with it the measurement role ---------------
  const roles = await s.eval(`(async () => {
    const { d, settle, click, drag, openTools, stampRow } = window.__SS;
    const img = d.getImages()[0];
    // Draw a zigzag line and save its shape. Deselect FIRST: US-096 made the
    // Stitches menu restyle the SELECTION when there is one and set the default
    // only when there is not, and the previous sections leave a placed line
    // selected — so without this the menu would restyle that line and the curve
    // below would be drawn plain.
    await click(img.x + 2, img.y + 2);
    await settle();
    document.getElementById('toolsMenuBtn').click(); await settle();
    document.getElementById('toolCurved').click(); await settle();
    document.getElementById('stitchesBtn').click(); await settle();
    document.querySelector('#stitchesMenu [data-style="zigzag"]').click(); await settle();
    await click(img.x + 30, img.y + 40);
    await click(img.x + 70, img.y + 20);
    await click(img.x + 110, img.y + 45);
    document.getElementById('toolSelect').click(); await settle();
    const stitch = d.getAnnotations()[d.getAnnotations().length - 1];
    await click(stitch.start.x, stitch.start.y);
    await openTools();
    document.getElementById('shapeStampSaveBtn').click(); await settle();
    const input = document.querySelector('.picker-overlay input[type="text"]');
    input.value = 'Topstitch path';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    // Place it and check the role.
    await openTools();
    stampRow('Topstitch path').querySelector('[data-stamp-action="use"]').click();
    await settle();
    await drag(img.x + 300, img.y + 40, img.x + 400, img.y + 90);
    const placedStitch = d.getAnnotations()[d.getAnnotations().length - 1];
    // Whether the COUNTER moved, not whether two birth-time seq fields differ.
    // Code review, 2026-08-23: the original compared placedStitch.seq against
    // the previous line's seq, but createAnnotationFromStamp stamps
    // seq = state.nextSequence BEFORE placeShapeStamp consults the counter, and
    // the zigzag source was born at that same value — so the two were equal
    // whether or not consumePomSequenceFor ran. The assertion could not fail.
    // Drawing a plain line afterwards reads the counter directly: it reuses the
    // number the construction mark did not spend.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    await click(img.x + 2, img.y + 2);
    document.getElementById('toolsMenuBtn').click(); await settle();
    document.getElementById('toolStraight').click(); await settle();
    document.getElementById('stitchesBtn').click(); await settle();
    document.querySelector('#stitchesMenu [data-style="solid"]').click(); await settle();
    await click(img.x + 300, img.y + 150);
    await click(img.x + 380, img.y + 150);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('toolSelect').click(); await settle();
    const nextPlain = d.getAnnotations()[d.getAnnotations().length - 1];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    document.getElementById('toolSelect').click();
    await settle();
    const specKeys = Array.from(document.querySelectorAll('#specBody tr[data-ann-id]'))
      .map(tr => Number(tr.dataset.annId));
    return {
      savedStyle: d.getShapeStamps().find(x => x.name === 'Topstitch path').style,
      placedStyle: placedStitch.style,
      measured: d.getMeasurementAnnIds().includes(placedStitch.id),
      exported: d.getExportAnnIds().includes(placedStitch.id),
      inSpecPanel: specKeys.includes(placedStitch.id),
      stitchSeq: placedStitch.seq,
      nextPlainSeq: nextPlain.seq,
      nextPlainStyle: nextPlain.style,
      placedId: placedStitch.id,
    };
  })()`);
  check(roles.savedStyle === 'zigzag' && roles.placedStyle === 'zigzag',
    `the look travels with the shape (saved ${roles.savedStyle}, placed ${roles.placedStyle})`);
  check(roles.measured === false && roles.inSpecPanel === false,
    'a stamp saved from a stitch line places a CONSTRUCTION mark — ADR 0055 still decides '
    + 'the role, and it decides it from the style the stamp carries');
  check(roles.exported === true,
    '...which is still drawn and still in the visual export set');
  check(roles.nextPlainStyle === 'solid',
    `precondition: the follow-up line was drawn plain (got ${roles.nextPlainStyle}), or it `
    + `would not be reading the counter as a measurement line does`);
  check(roles.nextPlainSeq === roles.stitchSeq,
    `...and spends no POM sequence number: the next MEASUREMENT line reuses the number the `
    + `construction mark was born holding (stitch ${roles.stitchSeq}, next plain `
    + `${roles.nextPlainSeq})`);

  // ---- 6. Undo, and the library's own lifecycle ----------------------------
  const lifecycle = await s.eval(`(async () => {
    const { d, settle } = window.__SS;
    const before = d.getAnnotations().length;
    document.getElementById('undoBtn').click();
    await settle();
    const afterUndo = d.getAnnotations().length;
    // Rename / reorder / delete through the real row controls.
    document.getElementById('toolsMenuBtn').click(); await settle();
    const rows = () => Array.from(document.querySelectorAll('#shapeStampList .preset-row'));
    const namesBefore = d.getShapeStamps().map(x => x.name);
    rows()[1].querySelector('[data-stamp-action="up"]').click(); await settle();
    const afterMove = d.getShapeStamps().map(x => x.name);
    const firstUpDisabled = rows()[0].querySelector('[data-stamp-action="up"]').disabled;
    rows()[0].querySelector('[data-stamp-action="rename"]').click(); await settle();
    const input = document.querySelector('.picker-overlay input[type="text"]');
    const prefilled = input.value;
    input.value = 'Topstitch';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    const afterRename = d.getShapeStamps().map(x => x.name);
    document.getElementById('toolsMenuBtn').click(); await settle();
    rows()[0].querySelector('[data-stamp-action="delete"]').click(); await settle();
    return { before, afterUndo, namesBefore, afterMove, firstUpDisabled, prefilled,
      afterRename, afterDelete: d.getShapeStamps().map(x => x.name),
      persisted: JSON.parse(localStorage.getItem('bra-shape-stamps-v1')) };
  })()`);
  check(lifecycle.afterUndo === lifecycle.before - 1,
    `one Undo removes a placed stamp (${lifecycle.before} -> ${lifecycle.afterUndo})`);
  check(lifecycle.afterMove.join('|') !== lifecycle.namesBefore.join('|'),
    `reorder moves a row (${JSON.stringify(lifecycle.namesBefore)} -> ${JSON.stringify(lifecycle.afterMove)})`);
  check(lifecycle.firstUpDisabled === true, 'the first row cannot move up');
  check(lifecycle.prefilled === lifecycle.afterMove[0],
    `rename opens pre-filled with the current name (got ${JSON.stringify(lifecycle.prefilled)})`);
  check(lifecycle.afterRename.includes('Topstitch'), 'rename takes effect');
  check(lifecycle.afterDelete.length === lifecycle.afterRename.length - 1, 'delete removes one');
  check(lifecycle.persisted && lifecycle.persisted.seeded === true,
    `the library is written with the one-shot seeded marker, or an emptied library `
    + `resurrects its contents on reload (got ${JSON.stringify(lifecycle.persisted && lifecycle.persisted.seeded)})`);

  // ---- 7. Portability: file round trip, and the project offer --------------
  const portability = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const settle = () => new Promise(r => setTimeout(r, 140));
    // Export through the real download path.
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    let captured = null, filename = null;
    HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    URL.createObjectURL = function (blob) { captured = blob; return 'blob:captured'; };
    try {
      document.getElementById('toolsMenuBtn').click(); await settle();
      document.getElementById('shapeStampExportBtn').click(); await settle();
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }
    const text = captured ? await captured.text() : null;
    const namesBefore = d.getShapeStamps().map(x => x.name);

    // Clear, then import that same file through the real input.
    d.resetShapeStamps();
    const input = document.getElementById('shapeStampFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([text || '{}'], 'shape-stamps.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 25 && !d.getShapeStamps().length; i += 1) await settle();
    const afterImport = d.getShapeStamps().map(x => x.name);

    // Project: embedded, offered, never applied over the local library.
    const project = d.exportProject();
    const withExtra = { ...project, state: { ...project.state, shapeStamps: [
      ...project.state.shapeStamps,
      { id: 'st-from-file', name: 'Only in the file', type: 'straight',
        start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, aspect: 1,
        style: 'solid', color: 'blue', lineWidth: 3, arrowType: 'none' },
    ] } };
    await d.loadProject(withExtra);
    await settle();
    const localAfterLoad = d.getShapeStamps().map(x => x.name);
    document.getElementById('toolsMenuBtn').click(); await settle();
    const offerRow = document.getElementById('shapeStampImportProjectBtn');
    const offered = { hidden: offerRow.hidden, label: offerRow.textContent };
    offerRow.click(); await settle();
    return { filename, blobType: captured && captured.type, exportedHasStamp: /Cup bottom/.test(text || ''),
      namesBefore, afterImport, embedded: (project.state.shapeStamps || []).length,
      localAfterLoad, offered, afterOffer: d.getShapeStamps().map(x => x.name) };
  })()`);
  check(portability.filename === 'shape-stamps.json' && portability.blobType === 'application/json',
    `Export writes a named JSON file (got ${JSON.stringify(portability.filename)}, ${portability.blobType})`);
  check(portability.exportedHasStamp === true, 'the exported bytes carry the library');
  check(portability.afterImport.join('|') === portability.namesBefore.join('|'),
    `the real file input round-trips the library exactly `
    + `(${JSON.stringify(portability.namesBefore)} -> ${JSON.stringify(portability.afterImport)})`);
  check(portability.embedded > 0, 'the project file carries a copy of the library');
  check(!portability.localAfterLoad.includes('Only in the file'),
    `opening a project must NOT silently add its shapes to the local library `
    + `(got ${JSON.stringify(portability.localAfterLoad)})`);
  check(portability.offered.hidden === false && /1 shape from project/.test(portability.offered.label),
    `...it offers them, and says how many (${JSON.stringify(portability.offered.label)})`);
  check(portability.afterOffer.includes('Only in the file'),
    'and clicking the row imports them');

  // ---- 8. Degenerate geometry ----------------------------------------------
  const degenerate = await s.eval(`(async () => {
    const { d, settle, click, drag, openTools, stampRow, shapeDeviation } = window.__SS;
    const img = d.getImages()[0];
    const results = {};
    for (const [name, x2, y2] of [['Flat horizontal', 160, 0], ['Flat vertical', 0, 120]]) {
      document.getElementById('toolsMenuBtn').click(); await settle();
      document.getElementById('toolStraight').click(); await settle();
      document.getElementById('stitchesBtn').click(); await settle();
      document.querySelector('#stitchesMenu [data-style="solid"]').click(); await settle();
      await click(img.x + 20, img.y + 200);
      await click(img.x + 20 + x2, img.y + 200 + y2);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.getElementById('toolSelect').click(); await settle();
      const line = d.getAnnotations()[d.getAnnotations().length - 1];
      await click((line.start.x + line.end.x) / 2, (line.start.y + line.end.y) / 2);
      await openTools();
      document.getElementById('shapeStampSaveBtn').click(); await settle();
      const input = document.querySelector('.picker-overlay input[type="text"]');
      if (!input) { results[name] = { saved: false }; continue; }
      input.value = name;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      const stamp = d.getShapeStamps().find(x => x.name === name);
      // A stamp whose geometry came out non-finite is REJECTED by the
      // normalizer, so it never reaches the list. Record that as a finding
      // rather than crashing on a missing row — a harness crash is a much
      // weaker signal than a named assertion.
      if (!stamp) { results[name] = { saved: false, aspect: null, rejected: true }; continue; }
      await openTools();
      const row = stampRow(name);
      if (!row) { results[name] = { saved: true, aspect: stamp.aspect, noRow: true }; continue; }
      row.querySelector('[data-stamp-action="use"]').click(); await settle();
      await drag(img.x + 380, img.y + 300, img.x + 500, img.y + 360);
      const placedLine = d.getAnnotations()[d.getAnnotations().length - 1];
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      const shape = d.sampleAnnotationShape(placedLine.id, 24);
      results[name] = {
        saved: !!stamp, aspect: stamp ? stamp.aspect : null,
        placedWidth: shape.width, placedHeight: shape.height,
        finite: Number.isFinite(placedLine.start.x) && Number.isFinite(placedLine.start.y)
          && Number.isFinite(placedLine.end.x) && Number.isFinite(placedLine.end.y),
      };
    }
    return results;
  })()`);
  for (const name of ['Flat horizontal', 'Flat vertical']) {
    const r = degenerate[name];
    check(r && r.saved === true,
      `${name}: a line with no extent on one axis is still saveable — dividing by the `
      + `collapsed axis puts NaN in the geometry, and the normalizer then rejects the whole `
      + `stamp${r && r.rejected ? ' (which is what happened)' : ''}`);
    check(r.noRow !== true, `${name}: the saved stamp reached the Tools-menu list`);
    check(r.aspect === 0,
      `${name}: a collapsed axis stores aspect 0 rather than 0 or Infinity from a divide `
      + `(got ${r.aspect})`);
    check(r.finite === true,
      `${name}: every placed coordinate is finite — a divide by the collapsed axis would `
      + `put NaN into the geometry, and clamp01 coerces NaN to 0 rather than throwing`);
    // Orientation is part of the shape: a flat horizontal line must stamp back
    // horizontal, and a flat vertical one vertical. Asserting "width > 1" for
    // both was simply wrong — a vertical line has no width, by definition.
    const horizontal = name === 'Flat horizontal';
    const along = horizontal ? r.placedWidth : r.placedHeight;
    const across = horizontal ? r.placedHeight : r.placedWidth;
    check(along > 1,
      `${name}: it places a line with real extent along its own axis `
      + `(got ${Math.round(r.placedWidth)}x${Math.round(r.placedHeight)})`);
    check(across < 1,
      `${name}: and stays flat across the other one — the orientation is part of the shape `
      + `(got ${Math.round(r.placedWidth)}x${Math.round(r.placedHeight)})`);
  }

  // ---- 9. Interior anchors, the model's headline claim ---------------------
  //
  // Every curve the suite saved until now had `points: []`, so the whole
  // interior-anchor path — the thing the stamp model advertises and the reason
  // the geometry collector walks handleIn/handleOut — was never executed. Found
  // by an adversarial audit; the capture existed and was asserted only as a
  // count of zero.
  const anchors = await s.eval(`(async () => {
    const { d, settle, click, drag, openTools, stampRow, shapeDeviation } = window.__SS;
    const img = d.getImages()[0];
    await click(img.x + 2, img.y + 2);
    document.getElementById('toolsMenuBtn').click(); await settle();
    document.getElementById('toolCurved').click(); await settle();
    await click(img.x + img.width * 0.10, img.y + img.height * 0.80);
    await click(img.x + img.width * 0.30, img.y + img.height * 0.55);
    await click(img.x + img.width * 0.55, img.y + img.height * 0.82);
    document.getElementById('toolSelect').click(); await settle();
    const curve = d.getAnnotations()[d.getAnnotations().length - 1];
    // Select it, then add an interior anchor with the US-093 Add point tool.
    await click(curve.start.x, curve.start.y);
    await settle();
    const addBtn = document.getElementById('toolAddPoint');
    const addAvailable = addBtn && !addBtn.hidden;
    if (addAvailable) {
      addBtn.click();
      await settle();
      // Click ON the curve. The CHORD midpoint is not on a bowed curve — the
      // point at t=0.5 of the cubic is: B(0.5) = (p0 + 3p1 + 3p2 + p3) / 8.
      const live = d.getAnnotations().find(a => a.id === curve.id);
      const half = {
        x: (live.start.x + 3 * live.control1.x + 3 * live.control2.x + live.end.x) / 8,
        y: (live.start.y + 3 * live.control1.y + 3 * live.control2.y + live.end.y) / 8,
      };
      await click(half.x, half.y);
      document.getElementById('toolSelect').click();
      await settle();
    }
    const withAnchor = d.getAnnotations().find(a => a.id === curve.id);
    const anchorCount = (withAnchor.points || []).length;
    if (!anchorCount) return { addAvailable, anchorCount: 0 };

    // Nudge the new anchor so the curve is unmistakably multi-segment.
    await click(withAnchor.start.x, withAnchor.start.y);
    await openTools();
    document.getElementById('shapeStampSaveBtn').click(); await settle();
    const input = document.querySelector('.picker-overlay input[type="text"]');
    input.value = 'Anchored curve';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    const stamp = d.getShapeStamps().find(x => x.name === 'Anchored curve');
    await openTools();
    stampRow('Anchored curve').querySelector('[data-stamp-action="use"]').click(); await settle();
    // Deliberately much smaller than the source, so "the shape survived" is a
    // claim about similarity across scale, not about copying at 1:1.
    await drag(img.x + img.width * 0.70, img.y + img.height * 0.05,
      img.x + img.width * 0.88, img.y + img.height * 0.18, { shiftKey: true });
    const placed = d.getAnnotations()[d.getAnnotations().length - 1];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    const src = d.sampleAnnotationShape(curve.id, 64);
    const out = d.sampleAnnotationShape(placed.id, 64);
    return {
      addAvailable, anchorCount,
      stampAnchorCount: stamp ? stamp.points.length : -1,
      placedAnchorCount: (placed.points || []).length,
      deviation: shapeDeviation(src, out),
      srcSize: src.width, placedSize: out.width,
      handlesFinite: (stamp ? stamp.points : []).every(pt =>
        Number.isFinite(pt.point.x) && Number.isFinite(pt.handleIn.x) && Number.isFinite(pt.handleOut.x)),
    };
  })()`);
  check(anchors.addAvailable === true,
    'precondition: the Add point tool is offered for a selected curve (US-093)');
  check(anchors.anchorCount >= 1,
    `precondition: an interior anchor was actually added — without one this whole section `
    + `re-tests the two-handle curve the earlier sections already cover `
    + `(got ${anchors.anchorCount})`);
  check(anchors.stampAnchorCount === anchors.anchorCount,
    `the stamp stores every interior anchor (curve has ${anchors.anchorCount}, `
    + `stamp kept ${anchors.stampAnchorCount})`);
  check(anchors.handlesFinite === true,
    'every stored anchor keeps both of its handles, finite');
  check(anchors.placedAnchorCount === anchors.anchorCount,
    `the placement rebuilds every interior anchor (got ${anchors.placedAnchorCount})`);
  check(anchors.placedSize / anchors.srcSize > 1.3 || anchors.srcSize / anchors.placedSize > 1.3,
    `precondition: the placement is a different size from the source `
    + `(${Math.round(anchors.srcSize)} vs ${Math.round(anchors.placedSize)})`);
  check(anchors.deviation < 0.03,
    `a multi-anchor curve keeps its shape through save and placement `
    + `(worst normalized deviation ${anchors.deviation.toFixed(4)})`);

  // ---- 10. Pixels: the placed curve is PAINTED where its geometry says -----
  //
  // validation.md promised this and nothing delivered it. Everything above
  // reads geometry; a renderer that ignored the rebuilt handles would pass all
  // of it. Sampling the painted canvas along the placed curve's own path is
  // the only assertion that closes that gap.
  const pixels = await s.eval(`(async () => {
    const { d, settle, redCount, drag, openTools, stampRow } = window.__SS;
    const img = d.getImages()[0];
    await openTools();
    stampRow('Cup bottom curve').querySelector('[data-stamp-action="use"]').click();
    await settle();
    await drag(img.x + img.width * 0.08, img.y + img.height * 0.10,
      img.x + img.width * 0.48, img.y + img.height * 0.34, { shiftKey: true });
    const placed = d.getAnnotations()[d.getAnnotations().length - 1];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Deselect: a selected line paints handles, which would count as ink.
    const canvas = document.getElementById('boardCanvas');
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 4, clientY: 4, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 4, clientY: 4, bubbles: true }));
    await settle();

    // Sample ON the curve at t=0.5, and at the CHORD midpoint — which for a
    // bowed curve is nowhere near it. Ink on the curve and none on the chord is
    // what "the bow was actually painted" means.
    const b = { x: (placed.start.x + 3 * placed.control1.x + 3 * placed.control2.x + placed.end.x) / 8,
      y: (placed.start.y + 3 * placed.control1.y + 3 * placed.control2.y + placed.end.y) / 8 };
    const chord = { x: (placed.start.x + placed.end.x) / 2, y: (placed.start.y + placed.end.y) / 2 };
    const win = (p) => ({ x: p.x - 6 / d.getView().zoom, y: p.y - 6 / d.getView().zoom,
      width: 12 / d.getView().zoom, height: 12 / d.getView().zoom });
    return {
      onCurve: redCount(win(b)),
      onChord: redCount(win(chord)),
      apartBy: Math.hypot(b.x - chord.x, b.y - chord.y),
      zoom: d.getView().zoom,
    };
  })()`);
  check(pixels.onCurve > 0,
    `the placed curve is actually PAINTED at the point its own geometry says it passes `
    + `through (got ${pixels.onCurve} line-coloured pixels)`);
  check(pixels.apartBy * pixels.zoom > 14,
    `precondition: the curve's t=0.5 point and its chord midpoint are far enough apart for `
    + `the next check to mean something (${(pixels.apartBy * pixels.zoom).toFixed(1)} screen px)`);
  check(pixels.onChord === 0,
    `...and NOT along its chord — a renderer that dropped the rebuilt handles would paint a `
    + `straight line here and every geometry assertion above would still pass `
    + `(got ${pixels.onChord} pixels on the chord)`);

  // ---- 11. The library survives a reload, and an emptied one stays empty ---
  const persistence = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    return { before: d.getShapeStamps().map(x => x.name) };
  })()`);
  check(persistence.before.length > 0, 'precondition: the library has entries to persist');
  await reloadKeepingErrors(s, ERROR_TRAP);
  const afterReload = await s.eval(`window.__braAutoModeDebug.getShapeStamps().map(x => x.name)`);
  check(JSON.stringify(afterReload) === JSON.stringify(persistence.before),
    `the shape library survives a reload exactly `
    + `(${JSON.stringify(persistence.before)} -> ${JSON.stringify(afterReload)})`);

  await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    d.resetShapeStamps();
    return d.getShapeStamps().length;
  })()`);
  await reloadKeepingErrors(s, ERROR_TRAP);
  const emptyAfterReload = await s.eval(`window.__braAutoModeDebug.getShapeStamps().map(x => x.name)`);
  check(emptyAfterReload.length === 0,
    `an emptied shape library STAYS empty across a reload — the one-shot seeded marker is `
    + `what distinguishes "stored nothing on purpose" from "never stored anything" `
    + `(got ${JSON.stringify(emptyAfterReload)})`);

  const corrupt = await s.eval(`(() => {
    localStorage.setItem('bra-shape-stamps-v1', '{not json');
    return true;
  })()`);
  check(corrupt === true, 'precondition: a corrupt payload was stored');
  await reloadKeepingErrors(s, ERROR_TRAP);
  // A corrupt payload has to be distinguishable from an absent one, so seed a
  // real library first and then corrupt it: "0 stamps" after a reload proves
  // nothing when the library was already empty. `threw` is measured, not
  // asserted as a literal — the first version hard-coded `threw: false`, which
  // is a tautology dressed as a check.
  const afterCorrupt = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    let threw = false;
    let stamps = -1;
    try { stamps = d.getShapeStamps().length; } catch (e) { threw = true; }
    let raw = null;
    try { raw = localStorage.getItem('bra-shape-stamps-v1'); } catch (e) {}
    return { stamps, threw, rawStillCorrupt: raw === '{not json' };
  })()`);
  check(afterCorrupt.threw === false,
    `reading a corrupt library must not throw (it did: ${JSON.stringify(afterCorrupt)})`);
  check(afterCorrupt.rawStillCorrupt === true,
    `precondition: the corrupt payload is still in storage at read time — if something had `
    + `already rewritten it, the fallback would not have been exercised`);
  check(afterCorrupt.stamps === 0,
    `...and falls back to an empty library (got ${afterCorrupt.stamps})`);

  // ---- 12. The armed tool is visible, and never a dead end ----------------
  //
  // Two fixes from the first audit that had no assertion of their own. Both are
  // about the ONE control still on screen while the stamp tool is armed: the
  // board is in a modal creation mode with the context-actions group hidden, so
  // if the trigger does not say what a press will do, nothing does.
  const armedUi = await s.eval(`(async () => {
    const { d, settle, click, openTools, stampRow, solidImage } = window.__SS;
    // Section 11 reloaded three times, so the board is empty again. A reload
    // is a fresh load — Sketch Focus (US-102) is session-only and resets to
    // POM Focus on every one, same as sketchMode's own fresh-load default —
    // so the Templates list (#shapeStampList, .sketch-mode-only) needs it
    // re-entered here too, or it goes back to display:none and this
    // section's own focus assertions (12/13 below) fail the same way the
    // very first section would have without it.
    if (!d.getImages().length) {
      await d.addBoardImages([solidImage('#ffffff', 700, 460)]);
      document.getElementById('modeManualBtn').click();
      await settle();
      document.getElementById('sketchFocusBtn').click();
      await settle();
    }
    const img = d.getImages()[0];
    d.resetShapeStamps();
    // Two shapes: one ordinary name, one long enough to need truncating.
    for (const name of ['Cup bottom curve', 'An extremely long saved shape name']) {
      await click(img.x + 2, img.y + 2);
      document.getElementById('toolsMenuBtn').click(); await settle();
      document.getElementById('toolStraight').click(); await settle();
      await click(img.x + img.width * 0.10, img.y + img.height * 0.50);
      await click(img.x + img.width * 0.40, img.y + img.height * 0.50);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.getElementById('toolSelect').click(); await settle();
      const line = d.getAnnotations()[d.getAnnotations().length - 1];
      await click((line.start.x + line.end.x) / 2, line.start.y);
      await openTools();
      document.getElementById('shapeStampSaveBtn').click(); await settle();
      const input = document.querySelector('.picker-overlay input[type="text"]');
      input.value = name;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    }
    const trigger = document.getElementById('toolsMenuBtn');
    const labelIdle = trigger.textContent;

    await openTools();
    stampRow('Cup bottom curve').querySelector('[data-stamp-action="use"]').click();
    await settle();
    const labelShort = trigger.textContent;

    await openTools();
    stampRow('An extremely long').querySelector('[data-stamp-action="use"]').click();
    await settle();
    const labelLong = trigger.textContent;

    // Delete the ARMED shape.
    await openTools();
    stampRow('An extremely long').querySelector('[data-stamp-action="delete"]').click();
    await settle();
    const labelAfterDelete = trigger.textContent;
    const statusAfterDelete = document.getElementById('toolStatus').textContent;

    // ...and a press must not still be trying to stamp.
    const before = d.getAnnotations().length;
    await click(img.x + img.width * 0.6, img.y + img.height * 0.3);
    return {
      labelIdle, labelShort, labelLong, labelAfterDelete,
      statusAfterDelete: statusAfterDelete.slice(0, 60),
      placedAfterDelete: d.getAnnotations().length !== before,
      remaining: d.getShapeStamps().length,
    };
  })()`);
  check(armedUi.labelIdle === 'Tools ▾',
    `precondition: with no tool armed the trigger is the plain label (got ${JSON.stringify(armedUi.labelIdle)})`);
  check(armedUi.labelShort === 'Tools: Cup bottom curve',
    `an armed stamp is NAMED on the toolbar — it used to read plain "Tools ▾", identical to `
    + `Select, while the board sat in a modal creation mode with the context actions hidden `
    + `(got ${JSON.stringify(armedUi.labelShort)})`);
  check(armedUi.labelLong.length < 30 && armedUi.labelLong.indexOf('…') !== -1,
    `...truncated, because a TD can name a shape anything `
    + `(got ${JSON.stringify(armedUi.labelLong)})`);
  check(armedUi.remaining === 1, 'precondition: the armed shape was the one deleted');
  check(armedUi.statusAfterDelete.indexOf('Shape') === -1,
    `deleting the ARMED shape must leave the stamp tool, not strand the board in a creation `
    + `mode that can create nothing (status still reads ${JSON.stringify(armedUi.statusAfterDelete)})`);
  check(armedUi.labelAfterDelete === 'Tools ▾',
    `...and the trigger goes back to its idle label (got ${JSON.stringify(armedUi.labelAfterDelete)})`);
  check(armedUi.placedAfterDelete === false,
    'and a press afterwards places nothing');

  // ---- 13. Reordering with the keyboard stays possible ---------------------
  //
  // The row controls are menu items, and the list is rebuilt wholesale after
  // every reorder. Without restoring focus, it lands on <body>, and because
  // moveBoardMenuFocus is bound on the menu element the keydown no longer
  // passes through it — arrow navigation of the whole Tools menu dies after
  // one press, and a repeated reorder needs the mouse.
  const keyboardReorder = await s.eval(`(async () => {
    const { d, settle, click, openTools } = window.__SS;
    const img = d.getImages()[0];
    // Need at least three entries to move one twice.
    while (d.getShapeStamps().length < 3) {
      await click(img.x + 2, img.y + 2);
      document.getElementById('toolsMenuBtn').click(); await settle();
      document.getElementById('toolStraight').click(); await settle();
      const n = d.getShapeStamps().length;
      await click(img.x + img.width * 0.10, img.y + img.height * (0.3 + n * 0.1));
      await click(img.x + img.width * 0.35, img.y + img.height * (0.3 + n * 0.1));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.getElementById('toolSelect').click(); await settle();
      const line = d.getAnnotations()[d.getAnnotations().length - 1];
      await click((line.start.x + line.end.x) / 2, line.start.y);
      await openTools();
      document.getElementById('shapeStampSaveBtn').click(); await settle();
      const input = document.querySelector('.picker-overlay input[type="text"]');
      input.value = 'Shape ' + (n + 1);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
    }
    await openTools();
    const rows = () => Array.from(document.querySelectorAll('#shapeStampList .preset-row'));
    const namesBefore = d.getShapeStamps().map(x => x.name);
    const lastId = rows()[rows().length - 1].dataset.stampId;
    const controlsAreMenuItems = rows()[0]
      .querySelector('[data-stamp-action="up"]').getAttribute('role') === 'menuitem';
    // Press Up on the LAST row, twice, without touching the mouse in between.
    rows()[rows().length - 1].querySelector('[data-stamp-action="up"]').click();
    await settle();
    const focusAfterFirst = document.activeElement;
    const focusedRowId = focusAfterFirst && focusAfterFirst.closest('[data-stamp-id]')
      ? focusAfterFirst.closest('[data-stamp-id]').dataset.stampId : null;
    const focusedAction = focusAfterFirst && focusAfterFirst.dataset
      ? focusAfterFirst.dataset.stampAction : null;
    // The second press goes to whatever now has focus — the keyboard path.
    if (focusAfterFirst && focusAfterFirst.click) focusAfterFirst.click();
    await settle();
    const namesAfter = d.getShapeStamps().map(x => x.name);
    // Focus AFTER the press that put the entry at index 0 — the press that
    // disables its own Up and therefore exercises the fallback. The first
    // version of this section stopped one press short of it.
    const focusAtTop = document.activeElement;
    return { controlsAreMenuItems, namesBefore, namesAfter, lastId, focusedRowId, focusedAction,
      focusedActionAtTop: focusAtTop && focusAtTop.dataset ? focusAtTop.dataset.stampAction : null,
      movedTo: namesAfter.indexOf(namesBefore[namesBefore.length - 1]) };
  })()`);
  check(keyboardReorder.controlsAreMenuItems === true,
    'the row controls are menu items, so arrow-key navigation inside a role=menu reaches them');
  check(keyboardReorder.focusedRowId === keyboardReorder.lastId
    && keyboardReorder.focusedAction === 'up',
    `after the list is re-rendered, focus returns to the SAME control on the SAME entry — `
    + `otherwise it falls to <body>, the menu's own keydown handler is no longer in the `
    + `propagation path, and arrow navigation of the whole Tools menu dies `
    + `(focus landed on ${JSON.stringify(keyboardReorder.focusedAction)} of row `
    + `${JSON.stringify(keyboardReorder.focusedRowId)})`);
  check(keyboardReorder.movedTo === 0,
    `...so pressing Up twice without re-grabbing walks the entry two places `
    + `(${JSON.stringify(keyboardReorder.namesBefore)} -> ${JSON.stringify(keyboardReorder.namesAfter)})`);
  // The press that lands the entry at index 0 disables its own Up, so the
  // fallback fires. Code review, 2026-08-23: the first fallback took "the first
  // non-disabled control in the row", which is the wide Apply/Use button — the
  // one control that CHANGES something. Parking focus there mid-reorder means
  // the TD's next Space applies a preset (a stitch preset silently turns the
  // selected measurement line into a construction mark) or arms the stamp tool
  // and closes the menu. A fallback must never land on a state-changing
  // command.
  check(keyboardReorder.focusedActionAtTop !== 'use'
    && keyboardReorder.focusedActionAtTop !== 'apply',
    `after the entry reaches the top its own Up is disabled, and the fallback must NOT land `
    + `on the row's state-changing Apply/Use button — the next keypress would fire it `
    + `(focus went to ${JSON.stringify(keyboardReorder.focusedActionAtTop)})`);
  check(keyboardReorder.focusedActionAtTop === 'down',
    `...it lands on the opposite arrow, which is both safe and where a TD who over-shot `
    + `wants to be (got ${JSON.stringify(keyboardReorder.focusedActionAtTop)})`);

  const errors = [...pageErrors, ...(await s.eval(`window.__ssErrors || []`))];
  check(errors.length === 0, `page errors during the run: ${JSON.stringify(errors)}`);

  s.close();
  console.log(`shape-stamps-check: PASS (${passed} checks)`);
}

function check(condition, message) {
  if (!condition) {
    process.exitCode = 1;
    throw new Error(message);
  }
  passed += 1;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function openCdpSession(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('no page target available');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
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
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evalJs = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
  return { eval: evalJs, waitFor, cdp, close: () => ws.close() };
}

async function waitForCdp(port) {
  for (let i = 0; i < 80; i += 1) {
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
