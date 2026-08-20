#!/usr/bin/env node
// US-086: browser-level contract for editing POM lines on the board after the
// Apply Lines handoff to Manual Mode.
//
// This is the first suite that drives real mousedown/mousemove/mouseup on
// #boardCanvas. Everything else (bom-check, construction-check) drives its own
// forked canvas, so before this file the whole manual pointer state machine —
// selection, endpoint drag, image drag, marquee — had zero automated proof.
// That gap is exactly how the defects this story fixes shipped: they produce
// silently wrong measurements, not crashes.
//
// Assertions are behavioural, not state-peeking: "press here, then this and
// only this moved". That survives refactors of the selection model, which is
// the part most likely to change next (hover + cycling, US-087).
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

// Injected once: world->screen using the debug view transform, synthetic drags
// on the real canvas, and a geometry snapshot/diff so every assertion can ask
// "what actually moved?" instead of trusting internal state.
const HARNESS = String.raw`
window.__BI = (() => {
  const d = window.__braAutoModeDebug;
  const canvas = document.getElementById('boardCanvas');
  const w2s = (p) => {
    const v = d.getView(); const r = canvas.getBoundingClientRect();
    return { x: p.x * v.zoom + v.panX + r.left, y: p.y * v.zoom + v.panY + r.top };
  };
  const ev = (type, x, y, opts) => canvas.dispatchEvent(new MouseEvent(type, Object.assign({
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    button: 0, buttons: type === 'mouseup' ? 0 : 1,
  }, opts || {})));
  const dragScreen = (sx, sy, dx, dy, opts) => {
    ev('mousedown', sx, sy, opts);
    for (let i = 1; i <= 4; i += 1) ev('mousemove', sx + dx * i / 4, sy + dy * i / 4, opts);
    ev('mouseup', sx + dx, sy + dy, opts);
  };
  const drag = (worldPt, dx, dy, opts) => { const s = w2s(worldPt); dragScreen(s.x, s.y, dx, dy, opts); };
  const click = (worldPt, opts) => { const s = w2s(worldPt); ev('mousedown', s.x, s.y, opts); ev('mouseup', s.x, s.y, opts); };
  const snapshot = () => {
    const anns = {};
    for (const a of d.getAnnotations()) anns[a.id] = { s: [a.start.x, a.start.y], e: [a.end.x, a.end.y], l: [a.label.x, a.label.y] };
    return { anns, img: d.getImages().map(i => [i.x, i.y, i.width]) };
  };
  const diff = (b, a) => {
    const out = { start: [], end: [], both: [], label: [], imageMoved: false };
    for (const id in b.anns) {
      const B = b.anns[id], A = a.anns[id];
      if (!A) continue;
      const ds = Math.hypot(A.s[0] - B.s[0], A.s[1] - B.s[1]);
      const de = Math.hypot(A.e[0] - B.e[0], A.e[1] - B.e[1]);
      const dl = Math.hypot(A.l[0] - B.l[0], A.l[1] - B.l[1]);
      if (ds > 0.5 && de > 0.5) out.both.push(Number(id));
      else if (ds > 0.5) out.start.push(Number(id));
      else if (de > 0.5) out.end.push(Number(id));
      else if (dl > 0.5) out.label.push(Number(id));
    }
    for (let i = 0; i < b.img.length; i += 1) {
      const B = b.img[i], A = a.img[i];
      if (Math.hypot(A[0] - B[0], A[1] - B[1]) > 0.5 || Math.abs(A[2] - B[2]) > 0.5) out.imageMoved = true;
    }
    return out;
  };
  // Curve-aware point + tangent, so "on the line" means the DRAWN geometry and
  // not the chord — a curved POM bulges well away from its chord.
  const onGeom = (a, t) => {
    if (a.type !== 'curved' || !a.control1 || !a.control2) {
      return { x: a.start.x + (a.end.x - a.start.x) * t, y: a.start.y + (a.end.y - a.start.y) * t };
    }
    const u = 1 - t;
    return {
      x: u*u*u*a.start.x + 3*u*u*t*a.control1.x + 3*u*t*t*a.control2.x + t*t*t*a.end.x,
      y: u*u*u*a.start.y + 3*u*u*t*a.control1.y + 3*u*t*t*a.control2.y + t*t*t*a.end.y,
    };
  };
  const tangent = (a, t) => {
    if (a.type !== 'curved' || !a.control1 || !a.control2) return { x: a.end.x - a.start.x, y: a.end.y - a.start.y };
    const u = 1 - t;
    return {
      x: 3*u*u*(a.control1.x-a.start.x) + 6*u*t*(a.control2.x-a.control1.x) + 3*t*t*(a.end.x-a.control2.x),
      y: 3*u*u*(a.control1.y-a.start.y) + 6*u*t*(a.control2.y-a.control1.y) + 3*t*t*(a.end.y-a.control2.y),
    };
  };
  const offGeom = (a, t, offsetPx) => {
    const p = onGeom(a, t), g = tangent(a, t);
    const len = Math.hypot(g.x, g.y) || 1;
    const z = d.getView().zoom;
    return { x: p.x + (-g.y / len) * (offsetPx / z), y: p.y + (g.x / len) * (offsetPx / z) };
  };
  // Press well clear of every photo so nothing but the empty-board branch runs.
  const clearSelection = () => {
    const im = d.getImages()[0];
    const s = w2s({ x: im.x - 80, y: im.y - 80 });
    ev('mousedown', s.x, s.y); ev('mouseup', s.x, s.y);
  };
  // Wait for the board to go quiescent, not just for loadProject to resolve:
  // the label-collision pass runs off a render frame, so a snapshot taken too
  // early is followed by labels drifting on their own and every "did my gesture
  // move anything?" assertion reads that drift as a failure.
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
  const restore = async () => { await d.loadProject(JSON.parse(JSON.stringify(window.__BI_BASE))); await settle(); };
  return { d, w2s, ev, drag, dragScreen, click, snapshot, diff, onGeom, offGeom, clearSelection, restore, settle };
})();
'ready'`;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'board-interaction-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    // A recognized test query param: without one, a view-role prompt can block
    // the run and the harness hangs instead of failing.
    `${started.baseUrl}/index.html?contract=boardinteraction${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`!!window.__braAutoModeDebug`, 20000);
  // The real CV engine must be up: on the free-CV fallback the detection is
  // different geometry, so the ambiguity this suite reasons about changes.
  await s.waitFor(`/ready/i.test(document.querySelector('#visionEngineChip')?.textContent || '')`, 60000);

  // Refuse to run against a stale bundle. Every assertion below is about code
  // that only exists after US-086, and a served-but-old app.js would report
  // those behaviours as "broken" and send the next reader hunting a phantom.
  const served = await s.eval(`(async () => {
    const src = document.querySelector('script[src*="app.js"]').getAttribute('src');
    const txt = await (await fetch(src)).text();
    return {
      src,
      hitTestAnyEndpoint: txt.includes('function hitTestAnyEndpoint'),
      dragArmed: txt.includes('function dragArmed'),
      gestureCanvasRect: txt.includes('gestureCanvasRect'),
      getInteraction: typeof window.__braAutoModeDebug.getInteraction === 'function',
    };
  })()`);
  for (const key of ['hitTestAnyEndpoint', 'dragArmed', 'gestureCanvasRect', 'getInteraction']) {
    check(served[key] === true,
      `the served bundle (${served.src}) predates US-086 — no ${key}. Run npm run build.`);
  }

  // Learning OFF for the whole run. Every gesture below is a real TD edit as
  // far as the app is concerned: an applied POM dragged in Manual Mode feeds
  // evaluateManualPomSample, so a suite that drives ~200 of them would pour
  // synthetic corrections into the calibration store and quietly bias
  // detection for every later run — and destabilise learning-tests with it.
  //
  // Not restored afterwards, deliberately. Chrome runs on a throwaway
  // --user-data-dir, so the store this writes to is per-run localStorage and
  // cannot outlive the process — and an s.eval() queued as a cleanup task runs
  // AFTER s.close(), where it never resolves and hangs the suite instead of
  // finishing it. Turning it off is about keeping THIS run deterministic:
  // learning bias would otherwise shift the anchors the assertions press on.
  const learningWasOn = await s.eval(`(() => {
    const l = window.__braAutoModeDebug.learning;
    const was = l.isEnabled();
    l.setEnabled(false);
    return was;
  })()`);
  console.log(`board-interaction-check: app ready (learning off for the run, was ${learningWasOn ? 'on' : 'off'})`);

  // ---- Set the board up exactly as a TD sees it after Apply Lines ----
  await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const blob = await (await fetch('demo/demo1.jpg')).blob();
    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    window.__BI_RUN = 'detecting';
    await d.runAutoOnDataUrl(dataUrl);
    // Pause here on purpose: applying the drafts consumes the anchors, and the
    // anchor-jiggle check below is the only place they can be exercised.
    window.__BI_RUN = 'detected';
    return 'kicked';
  })()`);
  await s.waitFor(`window.__BI_RUN === 'detected'`, 180000);

  // ---- Auto Mode: a jitter-click must not move an anchor ----
  // Higher stakes than a line: a moved anchor is snapped to the nearest ink on
  // mouseup AND filed as a TD correction the learner trains on, so an accident
  // here teaches the model something nobody did. Runs BEFORE Apply, because
  // Apply consumes the anchors and loadProject does not carry them — placing it
  // later made it skip silently, which is worse than not having it.
  const anchorJiggle = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const v = d.getView(), r = canvas.getBoundingClientRect();
    const w2s = (p) => ({ x: p.x * v.zoom + v.panX + r.left, y: p.y * v.zoom + v.panY + r.top });
    const ev = (t, x, y) => canvas.dispatchEvent(new MouseEvent(t, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: t === 'mouseup' ? 0 : 1 }));
    const anchors = d.getAnchors();
    const img = d.getImages()[0];
    if (!anchors || !anchors.length || !img) return { skipped: true, mode: d.getState().appMode, n: (anchors || []).length };
    const a = anchors[0];
    const before = { x: a.x, y: a.y };
    const s0 = w2s({ x: img.x + a.x * img.width, y: img.y + a.y * img.height });
    ev('mousedown', s0.x, s0.y);
    for (let i = 1; i <= 4; i += 1) ev('mousemove', s0.x + 2 * i / 4, s0.y + 1 * i / 4);
    ev('mouseup', s0.x + 2, s0.y + 1);
    const after = d.getAnchors().find(z => z.id === a.id);
    return {
      skipped: false, kind: a.kind, mode: d.getState().appMode,
      movedNorm: after ? +Math.hypot(after.x - before.x, after.y - before.y).toFixed(6) : -1,
    };
  })()`);
  check(anchorJiggle.skipped === false,
    `the anchor-jiggle check found no anchors to press (mode ${anchorJiggle.mode}, ${anchorJiggle.n} anchors) — it must not skip silently`);
  check(anchorJiggle.mode === 'auto', `anchors are only interactive in Auto Mode, got ${anchorJiggle.mode}`);
  check(anchorJiggle.movedNorm === 0,
    `a 2px press on the ${anchorJiggle.kind} anchor moved it ${anchorJiggle.movedNorm} in normalized space — anchor drags must arm like every other gesture`);
  console.log(`board-interaction-check: sub-3px press leaves the ${anchorJiggle.kind} anchor alone`);

  await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    d.approveDrawableDrafts();
    d.applyApprovedDrafts();
    window.__BI_RUN = 'done';
    return 'applied';
  })()`);
  await s.waitFor(`window.__BI_RUN === 'done'`, 60000);

  const setup = await s.eval(`({
    appMode: window.__braAutoModeDebug.getState().appMode,
    annCount: window.__braAutoModeDebug.getAnnotations().length,
    imageCount: window.__braAutoModeDebug.getImages().length,
  })`);
  check(setup.appMode === 'manual', `Apply Lines must hand off to Manual Mode, got ${setup.appMode}`);
  check(setup.annCount >= 15, `expected the applied POM lines, got ${setup.annCount}`);
  check(setup.imageCount === 1, `expected one sketch photo, got ${setup.imageCount}`);
  console.log(`board-interaction-check: ${setup.annCount} lines applied, Manual Mode`);

  await s.eval(HARNESS);
  await s.eval(`window.__BI_BASE = window.__braAutoModeDebug.exportProject(); 'saved'`);

  // ---- 0. The board holds still when the chrome around it reflows ----
  // US-088. `canvas { width:100%; height:100% }` means a backing buffer that
  // does not follow its CSS box is not clipped, it is STRETCHED — the board is
  // painted at the wrong scale while the pointer code still assumes 1:1. That
  // is invisible to every other assertion here, because they all compute screen
  // positions the same (wrong) way the app does, so both sides of the
  // comparison move together and agree with each other while disagreeing with
  // the pixels the TD is aiming at. It has to be measured against the PAINTED
  // geometry — buffer size vs CSS box — or it does not get caught at all.
  const reflow = await s.eval(`(async () => {
    const B = window.__BI;
    const canvas = document.getElementById('boardCanvas');
    const dpr = () => Math.max(1, window.devicePixelRatio || 1);
    // Where a fixed world point is PAINTED on screen, which is the app's own
    // answer adjusted by however far the buffer is being stretched.
    const painted = (p) => {
      const r = canvas.getBoundingClientRect();
      const s = B.w2s(p);
      const sx = r.width / (canvas.width / dpr());
      const sy = r.height / (canvas.height / dpr());
      return { x: r.left + (s.x - r.left) * sx, y: r.top + (s.y - r.top) * sy };
    };
    const bufferOff = () => {
      const r = canvas.getBoundingClientRect();
      return {
        w: canvas.width - Math.round(r.width * dpr()),
        h: canvas.height - Math.round(r.height * dpr()),
      };
    };
    const im = B.d.getImages()[0];
    // Probe the far corners: a scale error is zero at the canvas origin and
    // grows with distance, so a centre-only probe understates it.
    const probes = [
      { x: im.x, y: im.y },
      { x: im.x + im.width, y: im.y + im.height * 0.5 },
      { x: im.x + im.width * 0.5, y: im.y + im.height },
    ];

    const run = async (label, act) => {
      await B.restore();
      B.clearSelection();
      await B.settle();
      const before = probes.map(painted);
      const r0 = canvas.getBoundingClientRect();
      await act();
      await B.settle();
      const after = probes.map(painted);
      const r1 = canvas.getBoundingClientRect();
      return {
        label,
        canvasTopDelta: +(r1.top - r0.top).toFixed(2),
        canvasHeightDelta: +(r1.height - r0.height).toFixed(2),
        canvasWidthDelta: +(r1.width - r0.width).toFixed(2),
        buffer: bufferOff(),
        drift: +Math.max(...before.map((b, i) => Math.hypot(after[i].x - b.x, after[i].y - b.y))).toFixed(2),
      };
    };

    const selecting = await run('selecting a line', async () => {
      const a = B.d.getAnnotations()[0];
      B.click(a.start);
    });
    const panel = await run('hiding the Measurements panel', async () => {
      document.getElementById('togglePanelBtn').click();
    });
    document.getElementById('togglePanelBtn').click();
    await B.settle();
    return { selecting, panel };
  })()`);
  console.log('board-interaction-check: chrome reflow ' + JSON.stringify(reflow));
  for (const row of [reflow.selecting, reflow.panel]) {
    // A vacuous pass is the failure mode to fear here: if the chrome stops
    // moving the canvas, this stops testing anything and would sit green
    // forever. Say so rather than quietly measuring nothing.
    check(row.canvasTopDelta !== 0 || row.canvasHeightDelta !== 0 || row.canvasWidthDelta !== 0,
      `${row.label} no longer changes the canvas box, so this assertion proves nothing. `
      + `Re-point it at whatever does move the canvas now, or drop it.`);
    check(row.buffer.w === 0 && row.buffer.h === 0,
      `${row.label} left the backing buffer ${JSON.stringify(row.buffer)} device px off its CSS box — `
      + `the board is being painted stretched, and every hit-test is wrong by a margin that grows down the canvas`);
    // 1px covers the rounding of the buffer to whole device pixels. The bug
    // this replaces drifted 27px at the bottom of a 1512px-wide window.
    check(row.drift <= 1,
      `${row.label} moved the board ${row.drift}px on screen — the drawing must not move when the chrome does`);
  }
  console.log('board-interaction-check: the board holds still and stays 1:1 through a chrome reflow');

  // ---- 1. An endpoint is grabbable on the FIRST press ----
  // Before US-086 this was 0 correct out of 36: hitTestSelectedHandles only ever
  // looked at the selected line, so the first press dragged the whole line.
  const endpoints = await s.eval(`(async () => {
    const B = window.__BI, rows = [];
    for (const a0 of B.d.getAnnotations()) {
      for (const which of ['start', 'end']) {
        await B.restore();
        B.clearSelection();
        const a = B.d.getAnnotations().find(x => x.id === a0.id);
        const before = B.snapshot();
        B.drag(a[which], 24, 24);
        const m = B.diff(before, B.snapshot());
        const onlyThisEnd = m[which].length === 1 && m[which][0] === a.id
          && !m.both.length && !m.imageMoved && !m[which === 'start' ? 'end' : 'start'].length;
        rows.push({
          seq: a.seq, grabbed: which, ok: onlyThisEnd,
          wholeLine: m.both.length > 0, image: m.imageMoved,
          otherLine: (m.start.concat(m.end)).some(id => id !== a.id),
        });
      }
    }
    await B.restore();
    return rows;
  })()`);
  const epOk = endpoints.filter(r => r.ok).length;
  const epWhole = endpoints.filter(r => r.wholeLine).length;
  const epImage = endpoints.filter(r => r.image).length;
  const epOther = endpoints.filter(r => !r.ok && r.otherLine).map(r => `POM${r.seq}.${r.grabbed}`);
  check(epWhole === 0, `pressing an endpoint must never drag the whole line; ${epWhole} did`);
  check(epImage === 0, `pressing an endpoint must never drag the photo; ${epImage} did`);
  // Coincident endpoints are a real property of the POM template — POM 1's end
  // IS POM 2's start — so a handful of grabs legitimately land on the sibling
  // line's endpoint. Nearest-wins cannot separate two identical points; cycling
  // (US-087) is what will.
  //
  // Asserted as an exact SET, not a count. A count of six passes just as
  // happily when six *different* grabs break, which is precisely what a
  // detection change would do — the failure this guard exists to catch would
  // slip through looking unchanged. When US-087 lands, this list shrinks and
  // the suite says so instead of staying quietly green.
  const EXPECTED_COINCIDENT = ['POM1.end', 'POM3.end', 'POM4.start', 'POM5.start', 'POM8.start', 'POM13.start'];
  const stolenSet = epOther.slice().sort().join(', ');
  const expectedSet = EXPECTED_COINCIDENT.slice().sort().join(', ');
  check(stolenSet === expectedSet,
    `endpoint grabs landing on a sibling POM changed.\n  expected: ${expectedSet}\n  actual:   ${stolenSet}\n` +
    `  If US-087's cycling landed, shorten EXPECTED_COINCIDENT. Otherwise this is a regression.`);
  check(epOk === endpoints.length - EXPECTED_COINCIDENT.length,
    `${epOk}/${endpoints.length} endpoint grabs were exact; expected ${endpoints.length - EXPECTED_COINCIDENT.length}`);
  console.log(`board-interaction-check: endpoint first-press ${epOk}/${endpoints.length} exact` +
    (epOther.length ? ` (coincident with a sibling POM: ${epOther.join(', ')})` : ''));

  // ---- 2. A near-miss of a line never moves the sketch ----
  // Before US-086, 14 of 18 presses 12px off a line dragged the whole photo.
  const misses = await s.eval(`(async () => {
    const B = window.__BI, rows = [];
    for (const a0 of B.d.getAnnotations()) {
      for (const off of [0, 6, 12, 20]) {
        await B.restore();
        B.clearSelection();
        const a = B.d.getAnnotations().find(x => x.id === a0.id);
        const before = B.snapshot();
        B.drag(B.offGeom(a, 0.30, off), 24, 24);
        const m = B.diff(before, B.snapshot());
        rows.push({ seq: a.seq, off, image: m.imageMoved, movedSomething: m.both.length + m.start.length + m.end.length > 0 });
      }
    }
    await B.restore();
    return rows;
  })()`);
  const imageStolen = misses.filter(r => r.image);
  check(imageStolen.length === 0,
    `a press near a line must never move the sketch; it moved for ${imageStolen.map(r => `POM${r.seq}@${r.off}px`).join(', ')}`);
  const onLineHits = misses.filter(r => r.off === 0 && r.movedSomething).length;
  const onLineTotal = misses.filter(r => r.off === 0).length;
  check(onLineHits === onLineTotal, `a press exactly on a line must grab it: ${onLineHits}/${onLineTotal}`);
  console.log(`board-interaction-check: ${misses.length} near-miss presses, photo never moved`);

  // ---- 3. The photo still moves — it just takes an explicit press first ----
  // The TD moves and copies photos after drafting, so this must not become a
  // locked backdrop; it becomes a two-press target.
  const photo = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    // A point on the photo that is clear of every line and label.
    const im = B.d.getImages()[0];
    const anns = B.d.getAnnotations();
    let spot = null, bestClear = -1;
    for (let fx = 0.04; fx <= 0.96; fx += 0.04) {
      for (let fy = 0.04; fy <= 0.96; fy += 0.04) {
        const p = { x: im.x + im.width * fx, y: im.y + im.height * fy };
        let near = Infinity;
        for (const a of anns) {
          for (let t = 0; t <= 1.0001; t += 0.05) {
            const q = B.onGeom(a, t);
            near = Math.min(near, Math.hypot(q.x - p.x, q.y - p.y));
          }
          near = Math.min(near, Math.hypot(a.label.x - p.x, a.label.y - p.y));
        }
        if (near > bestClear) { bestClear = near; spot = p; }
      }
    }
    const clearPx = bestClear * B.d.getView().zoom;
    const before1 = B.snapshot();
    B.drag(spot, 30, 30);                       // first press: select only
    const after1 = B.diff(before1, B.snapshot());
    const before2 = B.snapshot();
    B.drag(spot, 30, 30);                       // second press: really move it
    const after2 = B.diff(before2, B.snapshot());
    await B.restore();
    // With the photo ALREADY selected, a press in the near-miss band around a
    // line must still not move it. Requiring selection alone protected only the
    // first mis-aim: the press that selects the photo leaves it selected, so
    // the next near-miss slid the sketch again (measured 25.5px before this).
    B.clearSelection();
    const a0 = B.d.getAnnotations()[0];
    B.click(spot);                              // adopt the photo
    const before3 = B.snapshot();
    B.drag(B.offGeom(a0, 0.30, 12), 24, 24);
    const after3 = B.diff(before3, B.snapshot());
    await B.restore();
    return {
      clearPx,
      firstPressMovedImage: after1.imageMoved,
      secondPressMovedImage: after2.imageMoved,
      nearMissMovedSelectedPhoto: after3.imageMoved,
    };
  })()`);
  check(photo.clearPx > 24, `test spot is only ${Math.round(photo.clearPx)}px from a line — too close to be conclusive`);
  check(photo.firstPressMovedImage === false, 'the first press on an unselected photo must not move it');
  check(photo.secondPressMovedImage === true, 'a press on an already-selected photo must move it');
  check(photo.nearMissMovedSelectedPhoto === false,
    'a near-miss of a line must not move the photo even once the photo is selected');
  console.log('board-interaction-check: photo needs select-then-drag, still movable, near-miss safe');

  // ---- 4. A press that barely moves is a click, not an edit ----
  // A control diff with no gesture runs first: if the board is not quiescent
  // the assertion below would blame the code for a settling artefact.
  const jiggle = await s.eval(`(async () => {
    const B = window.__BI;
    const summarise = (m) => ({
      moved: m.both.length + m.start.length + m.end.length + m.label.length > 0 || m.imageMoved,
      detail: { whole: m.both, start: m.start, end: m.end, label: m.label, image: m.imageMoved },
    });
    await B.restore();
    B.clearSelection();
    const quiet0 = B.snapshot();
    await B.settle();
    const control = summarise(B.diff(quiet0, B.snapshot()));
    const a = B.d.getAnnotations()[0];
    const sweep = [];
    for (const [dx, dy] of [[1,0],[2,1],[4,2],[8,4],[12,6]]) {
      await B.restore();
      B.clearSelection();
      const aa = B.d.getAnnotations()[0];
      const b0 = B.snapshot();
      const at = B.w2s(B.onGeom(aa, 0.30));
      const rectBefore = document.getElementById('boardCanvas').getBoundingClientRect();
      const viewBefore = B.d.getView();
      B.ev('mousedown', at.x, at.y);
      const rectAfter = document.getElementById('boardCanvas').getBoundingClientRect();
      const viewAfter = B.d.getView();
      const shift = { top: +(rectAfter.top - rectBefore.top).toFixed(2), left: +(rectAfter.left - rectBefore.left).toFixed(2),
        panY: +(viewAfter.panY - viewBefore.panY).toFixed(2), panX: +(viewAfter.panX - viewBefore.panX).toFixed(2) };
      const opened = B.d.getInteraction();
      for (let i = 1; i <= 4; i += 1) B.ev('mousemove', at.x + dx*i/4, at.y + dy*i/4);
      const during = B.d.getInteraction();
      B.ev('mouseup', at.x + dx, at.y + dy);
      const s1 = B.snapshot();
      const z = B.d.getView().zoom;
      sweep.push({
        pressPx: +Math.hypot(dx, dy).toFixed(2),
        movedPx: +(Math.hypot(s1.anns[aa.id].s[0] - b0.anns[aa.id].s[0], s1.anns[aa.id].s[1] - b0.anns[aa.id].s[1]) * z).toFixed(2),
        zoom: +z.toFixed(3), shift,
        openedType: opened ? opened.type : null,
        openedArmed: opened ? opened.armed : null,
        armedDuring: during ? during.armed : null,
      });
    }
    await B.restore();
    B.clearSelection();
    const before = B.snapshot();
    B.drag(B.onGeom(a, 0.30), 2, 1);
    const jig = summarise(B.diff(before, B.snapshot()));
    await B.restore();
    return { control, jig, sweep };
  })()`);
  check(jiggle.control.moved === false,
    `the board is not quiescent, so the jiggle assertion cannot be trusted: ${JSON.stringify(jiggle.control.detail)}`);
  console.log('board-interaction-check: press/move sweep ' + JSON.stringify(jiggle.sweep));
  check(jiggle.jig.moved === false,
    `a 2px press must not change any geometry, but moved ${JSON.stringify(jiggle.jig.detail)}`);
  // The sweep is the real guard, and it also pins down the canvas-reflow bug
  // that made the threshold unenforceable: selecting a line reveals the
  // contextual toolbar row and shifts the canvas (logged as `shift.top`), so a
  // rect read live mid-gesture put the first mousemove ~35px away from the
  // press. Gesture-pinned rect + threshold together must give: nothing below
  // 3px, real tracking above it.
  //
  // `shift` is read synchronously inside the mousedown task, so it reports
  // top=35.5 with panY=0 even though US-088's resizeCanvas compensates that
  // shift — the ResizeObserver has not run yet at that instant. That pairing is
  // correct, not a broken compensation: within the task the pinned rect and the
  // pan are still each other's match, and by the time anything is painted both
  // have moved together. Check 0 above is what covers the settled state.
  for (const row of jiggle.sweep) {
    // The gesture must be the one under test, and it must open UNARMED —
    // otherwise "nothing moved" below could just mean the press never reached
    // the line, and the threshold would look enforced while doing nothing.
    check(row.openedType === 'drag-annotation',
      `the ${row.pressPx}px press opened ${row.openedType} instead of a line drag`);
    check(row.openedArmed === false,
      `the ${row.pressPx}px press opened already armed, so the threshold is not being applied`);
    check(row.armedDuring === (row.pressPx > 3),
      `the ${row.pressPx}px press ended armed=${row.armedDuring}; the 3px gate should decide it`);
    if (row.pressPx <= 3) {
      check(row.movedPx === 0, `a ${row.pressPx}px press must move nothing, moved ${row.movedPx}px (canvas shift ${JSON.stringify(row.shift)})`);
    } else {
      check(row.movedPx > 0, `a ${row.pressPx}px press must drag the line, moved ${row.movedPx}px`);
      // Equal, not merely bounded: once armed the line must sit under the
      // cursor, with the 3px of travel spent on the threshold applied as a
      // catch-up rather than discarded. A permanent lag means dragArmed went
      // back to re-basing prevWorld; more than the travel means the canvas rect
      // is shifting mid-gesture again.
      check(Math.abs(row.movedPx - row.pressPx) <= 1,
        `a ${row.pressPx}px press moved the line ${row.movedPx}px — after arming the drag must track the pointer 1:1`);
    }
  }
  console.log('board-interaction-check: sub-3px press changes nothing, larger presses track 1:1');

  // ---- 4b. A grabbed endpoint carries its curve handle rigidly ----
  // dragHandle moves control1/control2 by the frame delta while SNAPPING the
  // endpoint. If the arming frame re-bases prevWorld the delta is zero there,
  // so the endpoint jumps and its handle does not — silently reshaping the
  // curve by the arming distance on every single endpoint edit.
  const curve = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    const a = B.d.getAnnotations().find(x => x.type === 'curved' && x.control1 && x.control2);
    if (!a) return { skipped: true };
    const c0 = { x: a.control1.x, y: a.control1.y }, s0 = { x: a.start.x, y: a.start.y };
    B.drag(a.start, 24, 16);
    const a2 = B.d.getAnnotations().find(x => x.id === a.id);
    const z = B.d.getView().zoom;
    await B.restore();
    return {
      skipped: false, seq: a.seq,
      startMovedPx: +(Math.hypot(a2.start.x - s0.x, a2.start.y - s0.y) * z).toFixed(2),
      controlMovedPx: +(Math.hypot(a2.control1.x - c0.x, a2.control1.y - c0.y) * z).toFixed(2),
      pointerPx: +Math.hypot(24, 16).toFixed(2),
    };
  })()`);
  if (curve.skipped) {
    console.log('board-interaction-check: no curved line on this board, rigid-handle check skipped');
  } else {
    check(Math.abs(curve.startMovedPx - curve.pointerPx) <= 1,
      `POM ${curve.seq} endpoint moved ${curve.startMovedPx}px for ${curve.pointerPx}px of travel`);
    check(Math.abs(curve.controlMovedPx - curve.startMovedPx) <= 1,
      `POM ${curve.seq}'s curve handle moved ${curve.controlMovedPx}px while its endpoint moved ${curve.startMovedPx}px — the handle must ride the endpoint rigidly or the curve reshapes on every edit`);
    console.log(`board-interaction-check: curved endpoint carries its handle rigidly (POM ${curve.seq})`);
  }

  // ---- 5. The gestures US-053 / US-057 rely on still work ----
  const groups = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    const anns = B.d.getAnnotations();
    // Shift+click two lines on their bodies, then drag one body: both move.
    const a = anns[0], b = anns[1];
    B.click(B.onGeom(a, 0.30), { shiftKey: true });
    B.click(B.onGeom(b, 0.30), { shiftKey: true });
    const before = B.snapshot();
    B.drag(B.onGeom(a, 0.30), 20, 20);
    const m = B.diff(before, B.snapshot());
    const groupMoved = m.both.includes(a.id) && m.both.includes(b.id);
    await B.restore();
    // A marquee dragged from clear board space still rubber-bands lines.
    // Asserted by behaviour, not by the panel: updateSpecHighlightOnly marks
    // only the PRIMARY row, so a 10-line marquee highlights exactly one row.
    B.clearSelection();
    const im = B.d.getImages()[0];
    const p0 = B.w2s({ x: im.x - 30, y: im.y - 30 });
    const p1 = B.w2s({ x: im.x + im.width + 30, y: im.y + im.height + 30 });
    B.dragScreen(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    const anns2 = B.d.getAnnotations();
    const beforeM = B.snapshot();
    B.drag(B.onGeom(anns2[0], 0.30), 20, 20);
    const mm = B.diff(beforeM, B.snapshot());
    const marqueeGroupMoved = mm.both.length;
    await B.restore();
    // A marquee started ON the photo also rubber-bands, instead of dragging it.
    B.clearSelection();
    const q0 = B.w2s({ x: im.x + im.width * 0.02, y: im.y + im.height * 0.02 });
    const q1 = B.w2s({ x: im.x + im.width * 0.98, y: im.y + im.height * 0.98 });
    const beforeP = B.snapshot();
    B.dragScreen(q0.x, q0.y, q1.x - q0.x, q1.y - q0.y);
    const photoMarquee = B.diff(beforeP, B.snapshot());
    const anns3 = B.d.getAnnotations();
    const beforeP2 = B.snapshot();
    B.drag(B.onGeom(anns3[0], 0.30), 20, 20);
    const pm = B.diff(beforeP2, B.snapshot());
    await B.restore();
    return {
      groupMoved, marqueeGroupMoved,
      photoMarqueeMovedImage: photoMarquee.imageMoved,
      photoMarqueeGroupMoved: pm.both.length,
    };
  })()`);
  check(groups.groupMoved === true, 'Shift+click multi-selection must still move as a group');
  check(groups.marqueeGroupMoved > 1,
    `a board-wide marquee must still select many lines; a follow-up drag moved ${groups.marqueeGroupMoved}`);
  check(groups.photoMarqueeMovedImage === false,
    'a drag started on the photo must rubber-band lines, not move the photo');
  check(groups.photoMarqueeGroupMoved > 1,
    `a drag across the photo must rubber-band the lines under it, got ${groups.photoMarqueeGroupMoved}`);
  console.log('board-interaction-check: multi-select and marquee intact, photo drag rubber-bands');

  // ---- 8. The buffer follows the pixel DENSITY, not just the box ----
  // Dragging the window from a Retina panel to an external 1080p monitor changes
  // devicePixelRatio while the CSS box stays identical. A ResizeObserver is
  // structurally blind to that, and `resize` is not guaranteed either — measured
  // here, Chrome emits one going 1 -> 2 and NONE going 2 -> 1. render() drawing
  // at the new density into a buffer sized for the old one puts the whole board
  // at 2x or 0.5x, which is the US-088 failure again by a different door.
  //
  // Runs last, and restores the override, because changing device metrics
  // resizes the viewport and would move every coordinate the checks above use.
  const density = await (async () => {
    const rows = [];
    const forceDraw = () => s.eval(`window.__braAutoModeDebug.setHiddenAnnIds([]); 'drawn'`);
    const settle = () => s.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))`);
    const sample = async label => {
      await settle();
      await forceDraw();
      await settle();
      rows.push(Object.assign({ label }, await s.eval(`(() => {
        const c = document.getElementById('boardCanvas');
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return { dpr, bufW: c.width, bufH: c.height,
          wantW: Math.round(r.width * dpr), wantH: Math.round(r.height * dpr) };
      })()`)));
    };
    await sample('baseline');
    for (const factor of [2, 1]) {
      await s.cdp('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: factor, mobile: false,
      });
      await sample(`deviceScaleFactor ${factor}`);
    }
    await s.cdp('Emulation.clearDeviceMetricsOverride', {});
    return rows;
  })();
  console.log('board-interaction-check: density ' + JSON.stringify(density));
  // A run where the emulation never actually changed dpr would pass every
  // assertion below while testing nothing.
  check(new Set(density.map(r => r.dpr)).size > 1,
    `the device-scale override did not change devicePixelRatio (${density.map(r => r.dpr).join(', ')}) — this assertion proves nothing as written`);
  for (const row of density) {
    check(row.bufW === row.wantW && row.bufH === row.wantH,
      `at ${row.label} (dpr ${row.dpr}) the backing buffer is ${row.bufW}x${row.bufH} but its CSS box needs ${row.wantW}x${row.wantH} — `
      + `the board is painted at ${(row.wantW / row.bufW).toFixed(2)}x the correct scale`);
  }
  console.log('board-interaction-check: the backing buffer tracks devicePixelRatio changes');

  const errors = await s.eval(`window.__toolbarConsoleErrors || []`);
  check(errors.length === 0, `page errors during the run: ${JSON.stringify(errors)}`);

  s.close();
  console.log(`board-interaction-check: PASS (${passed} checks)`);
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
  await cdp('Runtime.enable');
  await cdp('Runtime.evaluate', { expression: `window.__toolbarConsoleErrors=[]; addEventListener('error',e=>window.__toolbarConsoleErrors.push(String(e.message||e.error)))` });
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
