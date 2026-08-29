#!/usr/bin/env node
// US-103: Smart Hit is Sketch-Focus-only, and every Sketch Focus entry resets
// the pending "next line" arrow default to none. Two independently locked
// behaviors sharing one story because both are POM-Focus/Sketch-Focus mode
// splits layered on top of US-099 (Smart Hit) and the existing arrow-type
// preference. See docs/stories/epics/E01-manual-mode/
// US-103-sketch-smart-hit-no-arrows-checklist.md for the requirements this
// proves, and US-102-sketch-mode.md / US-099-treatment-scale-smart-placement
// for the features this extends.
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
  userDataDir = await mkdtemp(path.join(tmpdir(), 'sketch-smart-hit-check-'));
  cleanup.push(() => rm(userDataDir, { recursive: true, force: true }).catch(() => {}));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--window-size=1440,900',
    `${started.baseUrl}/index.html?smarthit=${Date.now()}`]);
  cleanup.push(() => new Promise(r => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(port);
  const s = await session(port);
  await s.waitFor('window.__braAutoModeDebug && document.getElementById("modeManualBtn")', 8000);

  // ---- Setup: Manual Mode, one board image, learning off --------------------
  await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    d.learning.setEnabled(false);
    const c = document.createElement('canvas'); c.width = 640; c.height = 420;
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 640, 420);
    await d.addBoardImages([c.toDataURL('image/png')]);
    document.getElementById('modeManualBtn').click();
    return true;
  })()`);
  await s.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))))');

  // 1: an explicit POM-side arrow preference, set BEFORE Sketch Focus, must
  // survive a full Sketch Focus visit untouched at exit — proven end to end
  // below, not just spot-checked at entry.
  const before = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('arrowDoubleBtn').click();
    return { arrowType: d.getState().arrowType, sketchMode: d.getState().sketchMode };
  })()`);
  check(before.sketchMode === false, 'precondition: still in POM Focus before this story starts');
  check(before.arrowType === 'double', 'precondition: the POM-side pending arrow default is really "double"');

  // 2: entering Sketch Focus resets the pending default to none and banks the
  // POM-side value state.pomArrowType is documented to restore later.
  const entered = await s.eval(`(() => {
    document.getElementById('sketchFocusBtn').click();
    const d = window.__braAutoModeDebug;
    return d.getState();
  })()`);
  check(entered.sketchMode === true, 'the Sketch toggle must actually enter Sketch Focus');
  check(entered.arrowType === 'none',
    `every entry into Sketch Focus must reset the pending arrow default to none, got ${JSON.stringify(entered.arrowType)}`);
  check(entered.pomArrowType === 'double',
    `entering Sketch Focus must bank the POM-side preference ("double") to restore later, got ${JSON.stringify(entered.pomArrowType)}`);

  // 3: a straight line drawn from a blank canvas in Sketch Focus is born with
  // no arrows — the real draw path (tool click + two canvas clicks), not a
  // pushed fixture, so this proves createStraightAnnotation actually reads
  // the reset default.
  const canvasSel = '#boardCanvas';
  const clickWorld = async (wx, wy) => {
    await s.eval(`(async () => {
      const canvas = document.querySelector('${canvasSel}');
      const d = window.__braAutoModeDebug, v = d.getView(), r = canvas.getBoundingClientRect();
      const x = ${wx} * v.zoom + v.panX + r.left, y = ${wy} * v.zoom + v.panY + r.top;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true, button: 0 }));
      await new Promise(r2 => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r2, 40))));
    })()`);
  };
  await s.eval(`document.getElementById('toolStraight').click()`);
  await clickWorld(80, 80);
  await clickWorld(180, 80);
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await s.eval(`document.getElementById('toolSelect').click()`);
  const straightDrawn = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const anns = d.getAnnotations();
    const ann = anns[anns.length - 1];
    return { type: ann.type, arrowType: ann.arrowType, id: ann.id };
  })()`);
  check(straightDrawn.type === 'straight', 'precondition: a straight line was actually drawn');
  check(straightDrawn.arrowType === 'none',
    `a straight line drawn during Sketch Focus must start with no arrows, got ${JSON.stringify(straightDrawn.arrowType)}`);

  // 4: same proof for a curved line (start, bow point, end).
  await s.eval(`document.getElementById('toolCurved').click()`);
  await clickWorld(80, 200);
  await clickWorld(130, 160);
  await clickWorld(180, 200);
  await s.eval(`document.getElementById('toolSelect').click()`);
  const curveDrawn = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const anns = d.getAnnotations();
    const ann = anns[anns.length - 1];
    return { type: ann.type, arrowType: ann.arrowType, id: ann.id };
  })()`);
  check(curveDrawn.type === 'curved', 'precondition: a curved line was actually drawn');
  check(curveDrawn.arrowType === 'none',
    `a curved line drawn during Sketch Focus must start with no arrows, got ${JSON.stringify(curveDrawn.arrowType)}`);

  // 5: selecting an existing ARROWED line (a real POM, style solid) while in
  // Sketch Focus must not steer the pending default away from none — proven
  // by drawing ANOTHER line right after and checking IT still gets none too,
  // not just checking state.arrowType immediately after the click (which
  // would not catch a bug where the poisoned value only bites on the next
  // draw).
  await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    d.styleEvidence.pushAnnotation({
      id: 96010, seq: 8, type: 'straight', style: 'solid', color: 'red', arrowType: 'double',
      lineWidth: 2.5, start: { x: 250, y: 80 }, end: { x: 350, y: 80 }, control1: null, control2: null,
      points: [], label: { x: 300, y: 62 }, labelManual: false, text: null, value: null,
    });
  })()`);
  await clickWorld(300, 80);
  const afterSelectArrowed = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    return { selection: d.getState().selection, arrowType: d.getState().arrowType };
  })()`);
  check(afterSelectArrowed.selection.kind === 'annotation' && afterSelectArrowed.selection.id === 96010,
    `precondition: the arrowed POM line was actually selected, got ${JSON.stringify(afterSelectArrowed.selection)}`);
  check(afterSelectArrowed.arrowType === 'none',
    `selecting an arrowed line in Sketch Focus must not steer the pending default, got ${JSON.stringify(afterSelectArrowed.arrowType)}`);
  await s.eval(`document.getElementById('toolStraight').click()`);
  await clickWorld(80, 260);
  await clickWorld(180, 260);
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await s.eval(`document.getElementById('toolSelect').click()`);
  const afterPoisonCheck = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const anns = d.getAnnotations();
    return anns[anns.length - 1].arrowType;
  })()`);
  check(afterPoisonCheck === 'none',
    `the NEXT line drawn after selecting an arrowed POM must still get none — the pending default was poisoned (got ${JSON.stringify(afterPoisonCheck)})`);

  // 6: an explicit Arrow menu change DURING Sketch Focus still works, both on
  // the selection and as the new pending default for the next drawn line.
  // Re-select the arrowed POM first — step 5's own draw left ITS OWN new
  // line selected, not 96010, and setArrowType restyles whatever is
  // currently selected.
  await s.eval(`(() => { window.__braAutoModeDebug.selectAnnotation(96010); })()`);
  await s.eval(`document.getElementById('arrowSingleBtn').click()`);
  const explicitDuring = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    return { pendingArrow: d.getState().arrowType, selectedArrow: d.getAnnotations().find(a => a.id === 96010).arrowType };
  })()`);
  check(explicitDuring.pendingArrow === 'single',
    `an explicit Arrow menu click during Sketch Focus must set the pending default, got ${JSON.stringify(explicitDuring.pendingArrow)}`);
  check(explicitDuring.selectedArrow === 'single',
    `an explicit Arrow menu click must still restyle the currently selected line, got ${JSON.stringify(explicitDuring.selectedArrow)}`);
  await s.eval(`(() => { window.__braAutoModeDebug.clearSelection(); })()`);
  await s.eval(`document.getElementById('toolStraight').click()`);
  await clickWorld(80, 320);
  await clickWorld(180, 320);
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await s.eval(`document.getElementById('toolSelect').click()`);
  const explicitLine = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const anns = d.getAnnotations();
    return anns[anns.length - 1].arrowType;
  })()`);
  check(explicitLine === 'single',
    `a line drawn after an explicit override must carry that override, not none (got ${JSON.stringify(explicitLine)})`);

  // 7: leaving Sketch Focus restores the ORIGINAL POM preference ("double"),
  // discarding the Sketch-scoped "single" override from step 6 entirely —
  // and existing annotations are never rewritten by ANY of this.
  const idsAndArrows = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    return d.getAnnotations().map(a => ({ id: a.id, arrowType: a.arrowType }));
  })()`);
  const left = await s.eval(`(() => {
    document.getElementById('sketchFocusBtn').click();
    const d = window.__braAutoModeDebug;
    return d.getState();
  })()`);
  check(left.sketchMode === false, 'the Sketch toggle must actually return to POM Focus');
  check(left.arrowType === 'double',
    `leaving Sketch Focus must restore the POM-side preference ("double"), not the Sketch-scoped override ("single") — got ${JSON.stringify(left.arrowType)}`);
  check(left.pomArrowType === null,
    `the POM-side backup must be cleared once restored, got ${JSON.stringify(left.pomArrowType)}`);
  const idsAndArrowsAfterExit = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    return d.getAnnotations().map(a => ({ id: a.id, arrowType: a.arrowType }));
  })()`);
  check(JSON.stringify(idsAndArrows) === JSON.stringify(idsAndArrowsAfterExit),
    `leaving Sketch Focus must never rewrite an existing annotation's arrows — before ${JSON.stringify(idsAndArrows)}, after ${JSON.stringify(idsAndArrowsAfterExit)}`);

  // 8: re-entering resets to none again — the "double" preference banked in
  // step 2 is not itself permanently stuck at "single" from step 6's detour.
  const reentered = await s.eval(`(() => {
    document.getElementById('sketchFocusBtn').click();
    const d = window.__braAutoModeDebug;
    return d.getState();
  })()`);
  check(reentered.arrowType === 'none', 'a second Sketch Focus entry must reset to none again, not carry over the prior override');
  check(reentered.pomArrowType === 'double', 'a second entry must bank the CURRENT POM preference ("double"), fresh');
  // Leave the board in POM Focus for the Smart Hit sections below (their own
  // gating story is the point; a stray leftover Sketch Focus would make the
  // "inert in POM Focus" checks meaningless).
  await s.eval(`document.getElementById('sketchFocusBtn').click()`);

  // ---- Smart Hit: multiple zoom levels ---------------------------------
  //
  // A Treatment layer's offset is a fixed SCREEN-size gap (US-099 design:
  // "fixed screen-size offsets"), so annotationVisualHitDistance divides it
  // by the current zoom to get the WORLD-space rail position — the rail
  // itself sits closer to the centerline in world units at a higher zoom, not
  // at a fixed world offset. The probe below re-derives that same
  // offset-over-zoom point fresh per zoom level (mirroring the app's own
  // math), rather than reusing one fixed world point, or every zoom past 1
  // would be probing empty space next to the rail instead of the rail.
  const zoomRail = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, canvas = document.querySelector('${canvasSel}');
    document.getElementById('sketchFocusBtn').click();
    d.applyLineTreatmentToIds([96010], { name: 'Rails', scale: 1, layers: [
      { pattern: 'solid', offset: -9, width: 2, color: 'black', spacing: 10, amplitude: 4 },
      { pattern: 'solid', offset: 9, width: 2, color: 'black', spacing: 10, amplitude: 4 },
    ] });
    d.clearSelection();
    const hostY = 80; // ann 96010's start.y === end.y
    const probeAt = async (zoom) => {
      d.setZoom(zoom);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))));
      const v = d.getView(), r2 = canvas.getBoundingClientRect();
      const railWorld = { x: 300, y: hostY - 9 / v.zoom };
      const x = railWorld.x * v.zoom + v.panX + r2.left, y = railWorld.y * v.zoom + v.panY + r2.top;
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, button: 0 }));
      await new Promise(r2b => setTimeout(r2b, 40));
      return d.getState().hoverAnnotationId;
    };
    const atZoom1 = await probeAt(1);
    const atZoom2 = await probeAt(2);
    const atZoom0_5 = await probeAt(0.5);
    d.setZoom(1);
    return { atZoom1, atZoom2, atZoom0_5 };
  })()`);
  check(zoomRail.atZoom1 === 96010, `Smart Hit must catch the rail at zoom 1, got ${JSON.stringify(zoomRail.atZoom1)}`);
  check(zoomRail.atZoom2 === 96010, `Smart Hit must catch the rail at zoom 2, got ${JSON.stringify(zoomRail.atZoom2)}`);
  check(zoomRail.atZoom0_5 === 96010, `Smart Hit must catch the rail at zoom 0.5, got ${JSON.stringify(zoomRail.atZoom0_5)}`);

  // ---- Smart Hit: overlap / topmost selection -------------------------
  //
  // Two treated lines with COINCIDENT geometry (same start/end): a click
  // exactly on their shared centerline scores an exact 0-distance hit
  // against BOTH, sidestepping any question of which way a layer's offset
  // points for this line's own direction — the point is deliberately
  // ambiguous between the two, so the only thing left to decide the winner
  // is z-order, and hitTestAnnotations (src/render/hit-testing.js) checks
  // topmost (highest array index / last-drawn) first and keeps it on a tie.
  const overlap = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const geometry = { start: { x: 100, y: 380 }, end: { x: 300, y: 380 }, control1: null, control2: null, points: [] };
    d.styleEvidence.pushAnnotation({
      id: 96020, seq: null, type: 'straight', style: 'solid', color: 'blue', arrowType: 'none',
      lineWidth: 2.5, ...geometry, label: { x: 200, y: 362 }, labelManual: false, text: null, value: null,
    });
    d.applyLineTreatmentToIds([96020], { name: 'A', scale: 1, layers: [
      { pattern: 'solid', offset: 10, width: 2, color: 'black', spacing: 10, amplitude: 4 },
    ] });
    d.styleEvidence.pushAnnotation({
      id: 96021, seq: null, type: 'straight', style: 'solid', color: 'green', arrowType: 'none',
      lineWidth: 2.5, ...geometry, label: { x: 200, y: 404 }, labelManual: false, text: null, value: null,
    });
    d.applyLineTreatmentToIds([96021], { name: 'B', scale: 1, layers: [
      { pattern: 'solid', offset: -10, width: 2, color: 'black', spacing: 10, amplitude: 4 },
    ] });
    d.clearSelection();
    return true;
  })()`);
  check(overlap === true, 'precondition: two overlapping treated lines were set up');
  const overlapHit = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, canvas = document.querySelector('${canvasSel}');
    const v = d.getView(), r = canvas.getBoundingClientRect();
    const world = { x: 200, y: 380 }; // exactly on the shared centerline
    const x = world.x * v.zoom + v.panX + r.left, y = world.y * v.zoom + v.panY + r.top;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true, button: 0 }));
    await new Promise(r2 => setTimeout(r2, 60));
    return d.getState().selection;
  })()`);
  check(overlapHit.kind === 'annotation' && (overlapHit.id === 96020 || overlapHit.id === 96021),
    `an overlap click must resolve to one real host annotation, never a layer id, got ${JSON.stringify(overlapHit)}`);
  check(overlapHit.id === 96021,
    `an overlap click must resolve to the TOPMOST (later-drawn) host, got ${JSON.stringify(overlapHit)}`);

  // ---- Smart Hit stays inert once back in POM Focus --------------------
  const inertAgain = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, canvas = document.querySelector('${canvasSel}');
    document.getElementById('sketchFocusBtn').click(); // -> POM Focus
    d.clearSelection();
    const v = d.getView(), r = canvas.getBoundingClientRect();
    const world = { x: 300, y: 71 }; // the rail probed above at zoom checks
    const x = world.x * v.zoom + v.panX + r.left, y = world.y * v.zoom + v.panY + r.top;
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, button: 0 }));
    await new Promise(r2 => setTimeout(r2, 40));
    return { sketchMode: d.getState().sketchMode, hover: d.getState().hoverAnnotationId };
  })()`);
  check(inertAgain.sketchMode === false, 'precondition: back in POM Focus for the inert check');
  check(inertAgain.hover !== 96010,
    `Smart Hit must go back to inert the moment Sketch Focus turns off, got hover=${JSON.stringify(inertAgain.hover)}`);

  const errors = await s.eval('window.__smartHitErrors || []');
  check(errors.length === 0, 'browser console errors: ' + errors.join(' | '));
  await s.close();
  console.log(`PASS  sketch-smart-hit-check   ${passed}/${passed} assertions ok`);
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
    expression: `window.__smartHitErrors=[];addEventListener('error',e=>window.__smartHitErrors.push(String(e.message||e.error)))`,
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
