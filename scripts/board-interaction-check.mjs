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
  // The inverse, for the one place that has to know EXACTLY which world point
  // the app will see. MouseEventInit types clientX/clientY as a C-style long, so a
  // synthetic click at a fractional screen position is silently rounded to
  // whole pixels — up to 0.71px away from the point the caller asked for, which
  // is 0.33 world px at this fixture's zoom. Every other check here tolerates
  // that; the curve-insertion check in section 4c measures at that scale, so it
  // clicks an integer pixel and asks this what the app received.
  const s2w = (sx, sy) => {
    const v = d.getView(); const r = canvas.getBoundingClientRect();
    return { x: (sx - r.left - v.panX) / v.zoom, y: (sy - r.top - v.panY) / v.zoom };
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
  // The DRAWN path of a curved annotation, as a dense polyline. Mirrors
  // getCurveBeziers (src/curves.js): start -> control1, then one cubic per
  // interior anchor (US-093 / ADR 0053), then control2 -> end. The whole bundle
  // is one IIFE so that function is unreachable from here, and the debug API
  // exposes no path sampler — reproduced in the harness rather than adding a
  // production hook that exists only for a test. The legacy
  // midPoint/midHandleIn/midHandleOut model is deliberately NOT modelled;
  // ensureCurveControls collapses it long before an applied POM reaches the
  // board, and the caller asserts midPoint is absent so this can never
  // silently sample the wrong curve.
  const curveSegs = (a) => {
    const pts = Array.isArray(a.points) ? a.points : [];
    const segs = [];
    let p0 = a.start, p1 = a.control1;
    for (const pt of pts) { segs.push([p0, p1, pt.handleIn, pt.point]); p0 = pt.point; p1 = pt.handleOut; }
    segs.push([p0, p1, a.control2, a.end]);
    return segs;
  };
  const pathPoints = (a, perSeg) => {
    const out = [];
    for (const s of curveSegs(a)) {
      for (let i = 0; i <= perSeg; i += 1) {
        const t = i / perSeg, u = 1 - t;
        out.push({
          x: u*u*u*s[0].x + 3*u*u*t*s[1].x + 3*u*t*t*s[2].x + t*t*t*s[3].x,
          y: u*u*u*s[0].y + 3*u*u*t*s[1].y + 3*u*t*t*s[2].y + t*t*t*s[3].y,
        });
      }
    }
    return out;
  };
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  };
  // How far the DRAWN shape moved: the symmetric Hausdorff distance between two
  // sampled paths, in world units. Parameterization-free on purpose — inserting
  // an anchor re-parameterizes the curve (one cubic becomes two, each spanning
  // half the old parameter range), so an equal-t comparison would report a
  // shape change that is not there, and a same-t agreement would say nothing
  // about the stretches in between.
  const pathDist = (p, poly) => {
    let best = Infinity;
    for (let i = 1; i < poly.length; i += 1) best = Math.min(best, segDist(p, poly[i - 1], poly[i]));
    return best;
  };
  const pathShift = (P, Q) => {
    let worst = 0;
    const oneWay = (from, to) => {
      for (const p of from) {
        const best = pathDist(p, to);
        if (best > worst) worst = best;
      }
    };
    oneWay(P, Q); oneWay(Q, P);
    return worst;
  };
  // ---- US-093 / ADR 0053 code review, 2026-08-21: handle ARBITRATION ----
  // hitTestSelectedHandles' candidate set, its per-candidate catch radius, and
  // the three rules that could pick a winner from it — mirrored here so a press
  // can be scored against the RIVAL rules as well as the shipped one.
  //
  // Nothing above needed this because every existing curve check presses an
  // EXACT handle position, where the distance is 0 and all three rules answer
  // identically. That is exactly why a first-match hit test shipped: the suite
  // could not tell the rules apart. Sections 4f press BETWEEN two handles whose
  // catch zones overlap, which is the only place they disagree.
  //
  // The part-name grammar and the two radii come from the app, not from a
  // constant here: __BI_GATE is read out of the served bundle by the caller.
  const partPoint = (a, part) => {
    const m = /^point([0-9]+)[.](point|handleIn|handleOut)$/.exec(part);
    if (m) { const pt = (a.points || [])[Number(m[1])]; return pt ? pt[m[2]] : null; }
    return a[part] || null;
  };
  // considerHandle's own sequence: DRAW order, bottom of the stack first, with
  // start/end last because render-annotations.js paints them over everything.
  const handleTargets = (a) => {
    const g = window.__BI_GATE;
    const out = [];
    const push = (part, p, r) => { if (p) out.push({ part: part, p: p, r: r }); };
    push('control1', a.control1, g.controlRadiusPx);
    push('control2', a.control2, g.controlRadiusPx);
    const pts = Array.isArray(a.points) ? a.points : [];
    for (let i = 0; i < pts.length; i += 1) {
      push('point' + i + '.handleIn', pts[i].handleIn, g.controlRadiusPx);
      push('point' + i + '.handleOut', pts[i].handleOut, g.controlRadiusPx);
      push('point' + i + '.point', pts[i].point, g.endpointRadiusPx);
    }
    push('start', a.start, g.endpointRadiusPx);
    push('end', a.end, g.endpointRadiusPx);
    return out;
  };
  // Distances in SCREEN px, which is the space both radii are written in.
  const scoreHandles = (a, world) => {
    const z = d.getView().zoom;
    return handleTargets(a).map(t => ({
      part: t.part, r: t.r,
      px: +(Math.hypot(world.x - t.p.x, world.y - t.p.y) * z).toFixed(3),
    }));
  };
  //   'nearest'      — what ships: least distance among the candidates that are
  //                    in range, with <= so a later (drawn-on-top) one takes a tie.
  //   'legacy-first' — the pre-fix rule: first match in declaration order, with
  //                    start/end tested FIRST and at the wider endpoint radius,
  //                    then the two base controls, then each anchor's handleIn /
  //                    handleOut / point in turn.
  //   'point-tier'   — the plausible alternative fix: every endpoint-sized
  //                    target (the anchors' points, start, end) before any
  //                    bend handle, on the theory that the bigger painted
  //                    handle should always win.
  const arbitrate = (a, world, rule) => {
    const g = window.__BI_GATE;
    const scored = scoreHandles(a, world);
    const admitted = scored.filter(t => t.px <= t.r);
    if (!admitted.length) return null;
    if (rule === 'nearest') {
      let best = null;
      for (const t of admitted) if (!best || t.px <= best.px) best = t;
      return best.part;
    }
    const order = rule === 'legacy-first'
      ? ['start', 'end', 'control1', 'control2']
        .concat(scored.filter(t => t.part.indexOf('point') === 0).map(t => t.part))
      : scored.filter(t => t.r === g.endpointRadiusPx).map(t => t.part)
        .concat(scored.filter(t => t.r === g.controlRadiusPx).map(t => t.part));
    for (const part of order) {
      const hit = admitted.find(t => t.part === part);
      if (hit) return hit.part;
    }
    return null;
  };
  // One press, no travel, and the gesture it opened. Asserting on
  // getInteraction().part rather than on "something moved" is deliberate: this
  // file's own history records that "nothing moved" is an ambiguous signal, and
  // a wrongly-arbitrated press moves SOMETHING either way.
  const pressPart = (screen) => {
    ev('mousedown', screen.x, screen.y);
    const it = d.getInteraction();
    ev('mouseup', screen.x, screen.y);
    return it ? { type: it.type, part: it.part, id: it.id } : null;
  };
  // Walk the segment between two competing handles for the INTEGER-pixel press
  // that the shipped rule hands to 'want' and 'rival' does not. Searched, not
  // assumed: the window where two catch zones overlap is a few pixels wide and
  // the fixture's own geometry decides where it is. Predictions are recomputed
  // from s2w of the rounded pixel, so MouseEventInit's integer clientX is part
  // of the arithmetic instead of a tolerance. Returns null rather than a weaker
  // press, so the caller fails loudly instead of testing nothing.
  //
  // The objective is the press closest to MIDWAY, not the one with the widest
  // margin. Widest margin lands the press half a pixel from the winner, where
  // the two handles are no longer really competing and the case degenerates
  // back into section 4c's "press the handle exactly". MIN_ARBITRATION_MARGIN
  // is what keeps midway from becoming a coin flip: at 1.5 screen px the winner
  // is unambiguous even though both candidates are well inside their radii.
  const MIN_ARBITRATION_MARGIN = 1.5;
  const findRivalPress = (a, fromPart, toPart, want, rival) => {
    const A = partPoint(a, fromPart), Z = partPoint(a, toPart);
    if (!A || !Z) return null;
    let best = null;
    for (let i = 1; i < 100; i += 1) {
      const f = i / 100;
      const s = w2s({ x: A.x + (Z.x - A.x) * f, y: A.y + (Z.y - A.y) * f });
      const screen = { x: Math.round(s.x), y: Math.round(s.y) };
      const exact = s2w(screen.x, screen.y);
      if (arbitrate(a, exact, 'nearest') !== want) continue;
      const rivalSays = arbitrate(a, exact, rival);
      if (rivalSays === want) continue;
      const near = scoreHandles(a, exact).filter(t => t.px <= t.r).sort((x, y) => x.px - y.px);
      const margin = near.length > 1 ? +(near[1].px - near[0].px).toFixed(3) : Infinity;
      if (margin < MIN_ARBITRATION_MARGIN) continue;
      if (!best || Math.abs(f - 0.5) < Math.abs(best.f - 0.5)) {
        best = { f: f, screen: screen, rivalSays: rivalSays, margin: margin, near: near.slice(0, 4) };
      }
    }
    return best;
  };
  // Drag a handle from where it is to a chosen world point, reporting which
  // handle the press actually grabbed so a scenario cannot silently build itself
  // out of the wrong geometry. Integer pixels throughout, matching pressPart.
  const dragHandleTo = (worldFrom, worldTo) => {
    const a0 = w2s(worldFrom), a1 = w2s(worldTo);
    const p0 = { x: Math.round(a0.x), y: Math.round(a0.y) };
    const p1 = { x: Math.round(a1.x), y: Math.round(a1.y) };
    ev('mousedown', p0.x, p0.y);
    const opened = d.getInteraction();
    for (let i = 1; i <= 6; i += 1) {
      ev('mousemove', p0.x + (p1.x - p0.x) * i / 6, p0.y + (p1.y - p0.y) * i / 6);
    }
    ev('mouseup', p1.x, p1.y);
    return opened ? { type: opened.type, part: opened.part } : null;
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
  return { d, w2s, s2w, ev, drag, dragScreen, click, snapshot, diff, onGeom, offGeom, curveSegs, pathPoints, pathDist, pathShift, clearSelection, restore, settle,
    partPoint, handleTargets, scoreHandles, arbitrate, pressPart, findRivalPress, dragHandleTo };
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
      // US-093 / ADR 0053 code review, 2026-08-21: the four numbers sections 4f
      // and 4h have to aim at — hitTestSelectedHandles' two catch radii and
      // handleAddPointClick's accept tolerance / minimum-separation gate — read
      // out of the bundle rather than copied into this file. All four were
      // re-tuned during this review (the separation gate twice), and a suite
      // that hard-codes them stops testing the code the day the next tune
      // lands: it would keep pressing a spot that is no longer on either side
      // of the boundary and stay green. Extracted with new RegExp so the
      // patterns need no backslashes — a plain template literal eats them.
      radii: (() => {
        const num = '([0-9.]+)';
        const one = (pattern) => {
          const m = txt.match(new RegExp(pattern));
          return m ? m.slice(1).map(Number) : null;
        };
        const ep = one('const endpointRadius = ' + num + ' / state[.]zoom;');
        const ct = one('const controlRadius = ' + num + ' / state[.]zoom;');
        const tol = one('const tolerance = Math[.]max[(]' + num
          + ', getLineWidth[(]ann[)] / 2 [+] ' + num + '[)] / state[.]zoom;');
        const sep = one('const minSeparation = tolerance / ' + num + ';');
        // US-093 / ADR 0053 code review, 2026-08-21: section 4j needs three more
        // numbers, and they belong to the UNSELECTED press path rather than to
        // hitTestSelectedHandles — hitTestAnyEndpoint's catch radius, and the
        // body and label tolerances the press falls through to when the endpoint
        // defers. 'const radius = N / state.zoom' is NOT unique in the bundle
        // (hitTestSelectedNoteHandles and hitTestImages carry their own), so each
        // is read out of its own function's text, sliced by name, instead of out
        // of the whole file.
        const inFn = (name, span, pattern) => {
          const at = txt.indexOf('function ' + name);
          if (at < 0) return null;
          const m = txt.slice(at, at + span).match(new RegExp(pattern));
          return m ? m.slice(1).map(Number) : null;
        };
        const anyEp = inFn('hitTestAnyEndpoint', 400, 'const radius = ' + num + ' / state[.]zoom;');
        const bodyTol = inFn('hitTestAnnotations', 900,
          'isPointNearAnnotation[(]world, ann, ' + num + ' / state[.]zoom[)]');
        const labelTol = inFn('hitTestAnnotations', 900,
          'pointInLabelBounds[(]world, ann[.]label, getLabelText[(]ann[)], ' + num + ' / state[.]zoom[)]');
        if (!ep || !ct || !tol || !sep || !anyEp || !bodyTol || !labelTol) return null;
        return {
          endpointRadiusPx: ep[0], controlRadiusPx: ct[0],
          addPointFloorPx: tol[0], addPointWidthPadPx: tol[1],
          addPointSeparationDivisor: sep[0],
          anyEndpointRadiusPx: anyEp[0], bodyTolerancePx: bodyTol[0], labelTolerancePx: labelTol[0],
        };
      })(),
    };
  })()`);
  for (const key of ['hitTestAnyEndpoint', 'dragArmed', 'gestureCanvasRect', 'getInteraction']) {
    check(served[key] === true,
      `the served bundle (${served.src}) predates US-086 — no ${key}. Run npm run build.`);
  }
  check(served.radii !== null,
    `could not read the handle catch radii, the Add-point gate and the unselected-press tolerances out of the served `
    + `bundle (${served.src}). Sections 4f, 4h and 4j aim AT those boundaries, so a shape change in `
    + `hitTestSelectedHandles / handleAddPointClick / hitTestAnyEndpoint / hitTestAnnotations has to re-point them here `
    + `rather than leave them pressing a stale coordinate.`);
  // Published to the page before the harness is installed, so its helpers can
  // score a press the way the app does without a second round-trip.
  await s.eval(`window.__BI_GATE = ${JSON.stringify(served.radii)}; 'ready'`);
  console.log('board-interaction-check: gate ' + JSON.stringify(served.radii));

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

  // ---- Auto Mode: the sketch carries its DRAFT lines, exactly as it carries
  // applied ones ----
  // Photos stay draggable in Auto Mode (US-052), and the drafts under review sit
  // on the photo. They live in state.autoMode.draftAnnotations rather than
  // state.annotations, and getAnnotationsOnImage used to filter only the latter,
  // so the photo and its anchors moved while all 18 drafts stayed put — then
  // Apply Lines committed them at those stale coordinates. Silently wrong
  // measurements, no error. Runs here because it needs the pre-Apply state, and
  // drags back afterwards so the checks below see the board it expects.
  const draftCarry = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const w2s = (p) => { const v = d.getView(); const r = canvas.getBoundingClientRect();
      return { x: p.x * v.zoom + v.panX + r.left, y: p.y * v.zoom + v.panY + r.top }; };
    const ev = (t, x, y) => canvas.dispatchEvent(new MouseEvent(t, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: t === 'mouseup' ? 0 : 1 }));
    const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));
    const drafts = () => (d.getDrafts() || []).filter(a => a && a.start && a.end);
    const snap = () => ({ img: d.getImages()[0].x, lines: drafts().map(a => ({ id: a.id, x: a.start.x, y: a.start.y })) });
    // A press point on the photo as far as possible from every anchor pin and
    // every draft, so the gesture is unambiguously about the photo.
    const im = d.getImages()[0];
    const pins = (d.getAnchors() || []).map(a => ({ x: im.x + a.x * im.width, y: im.y + a.y * im.height }));
    let spot = null, bestClear = -1;
    for (let gx = 1; gx <= 14; gx += 1) for (let gy = 1; gy <= 14; gy += 1) {
      const p = { x: im.x + im.width * gx / 15, y: im.y + im.height * gy / 15 };
      let clear = Infinity;
      for (const a of pins) clear = Math.min(clear, Math.hypot(p.x - a.x, p.y - a.y));
      for (const l of drafts()) {
        const vx = l.end.x - l.start.x, vy = l.end.y - l.start.y;
        const len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - l.start.x) * vx + (p.y - l.start.y) * vy) / len2));
        clear = Math.min(clear, Math.hypot(p.x - (l.start.x + vx * t), p.y - (l.start.y + vy * t)));
      }
      if (clear > bestClear) { bestClear = clear; spot = p; }
    }
    const pull = (dx) => {
      const c = w2s(spot);
      ev('mousedown', c.x, c.y); ev('mouseup', c.x, c.y);          // select the photo
      ev('mousedown', c.x, c.y);
      const opened = (d.getInteraction() || {}).type;
      for (let i = 1; i <= 6; i += 1) ev('mousemove', c.x + dx * i / 6, c.y);
      ev('mouseup', c.x + dx, c.y);
      return opened;
    };
    const before = snap();
    const opened = pull(200);
    await settle();
    const after = snap();
    const imgDx = after.img - before.img;
    const byId = new Map(before.lines.map(l => [l.id, l]));
    const deltas = after.lines.map(l => { const p = byId.get(l.id); return p ? +(l.x - p.x).toFixed(2) : null; });
    pull(-200);                                                     // put the board back
    await settle();
    const restoredDx = +(snap().img - before.img).toFixed(2);
    return { opened, mode: d.getState().appMode, nDrafts: before.lines.length,
      imgDx: +imgDx.toFixed(2), deltas, restoredDx };
  })()`);
  check(draftCarry.mode === 'auto', `this check needs the pre-Apply Auto state, got ${draftCarry.mode}`);
  check(draftCarry.opened === 'drag-image',
    `the press was meant to grab the photo but opened ${draftCarry.opened} — re-aim it, or it proves nothing`);
  check(draftCarry.nDrafts >= 15, `expected the generated drafts, got ${draftCarry.nDrafts}`);
  check(Math.abs(draftCarry.imgDx) > 1, `the photo did not move (${draftCarry.imgDx}) — nothing was tested`);
  const strays = draftCarry.deltas.filter(d => d == null || Math.abs(d - draftCarry.imgDx) > 0.5);
  check(strays.length === 0,
    `the photo moved ${draftCarry.imgDx} world units but ${strays.length}/${draftCarry.deltas.length} drafts did not follow it `
    + `(deltas ${JSON.stringify(draftCarry.deltas.slice(0, 6))}...) — Apply would commit them at stale coordinates`);
  check(Math.abs(draftCarry.restoredDx) < 0.5,
    `the drag-back left the board ${draftCarry.restoredDx} off, so the checks below start from the wrong state`);
  console.log(`board-interaction-check: the sketch carries all ${draftCarry.nDrafts} drafts in Auto Mode (${draftCarry.imgDx} world units)`);

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
  await s.eval(`window.__BI_REFLOW = (() => {
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

    // Kept on window rather than run inline: the height-axis scenario below has
    // to be driven between two node-side CDP device-metrics calls, so the two
    // scenarios can no longer share one page eval.
    return { run };
  })(); 'ready'`);

  // Scenario 1 of 2: the canvas WIDTH axis. Hiding the whole Measurements side
  // panel is the widest reflow a TD can trigger.
  const panelRow = await s.eval(`(async () => {
    const row = await window.__BI_REFLOW.run('hiding the Measurements panel', async () => {
      document.getElementById('togglePanelBtn').click();
    });
    document.getElementById('togglePanelBtn').click();
    await window.__BI.settle();
    return row;
  })()`);

  // Scenario 2 of 2: the canvas HEIGHT/TOP axis — the axis ADR 0051 was
  // actually about, where a wrapped contextual-toolbar row pushes the canvas
  // 35.5px down mid-gesture.
  //
  // US-093 / ADR 0053 code review, 2026-08-21: this axis had been left with no
  // live proof at all. Consolidating Straight/Curved/Eraser/Text into one
  // drop-down did free toolbar width, and the old "selecting a line" scenario
  // was retired on the strength of an unrecorded claim that no selection
  // reflows the height any more. Measured for real, on this fixture, in the
  // state run() actually presents (post-restore, so Undo/Redo/Paste are hidden
  // and the strip is at its narrowest), toolbar height before -> after:
  //
  //     width   straight selected     CURVED selected
  //     1440    95.5 -> 95.5          95.5 -> 95.5
  //     1366    95.5 -> 95.5          95.5 -> 131.0   <-- curve only
  //     1280    95.5 -> 131.0         95.5 -> 131.0
  //     1100    95.5 -> 131.0         95.5 -> 137.3
  //
  // So the claim was right at 1440 and wrong everywhere below it. 1366 is the
  // width to test at, and not an arbitrary one: it is the commonest laptop
  // width there is, and it is the only tested width where the reflow is
  // attributable to US-093's own chrome — a straight line still fits, and it is
  // the 38px "Add point" button revealed by a CURVED selection that tips the
  // strip into a second row, moving the canvas top 164.5 -> 200.0 and its
  // height 722.5 -> 687.0. That is the same 35.5px as the original bug, from an
  // ordinary TD action, and the assertions below are live rather than a comment
  // asserting it from memory. (In the un-restored post-Apply state, where Undo
  // is showing, the same reflow happens at 1440 too — measured 95.5 -> 131.0.)
  const REFLOW_HEIGHT_WIDTH = 1366;
  await s.cdp('Emulation.setDeviceMetricsOverride', {
    width: REFLOW_HEIGHT_WIDTH, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  const curvedResult = await s.eval(`(async () => {
    const B = window.__BI;
    await B.settle();
    let pick = { found: false, viewport: document.documentElement.clientWidth };
    const row = await window.__BI_REFLOW.run(
      'selecting a curved line at ' + document.documentElement.clientWidth + 'px', async () => {
        const a = B.d.getAnnotations().find(x => x.type === 'curved' && x.control1 && x.control2);
        if (!a) return;
        // The same press section 4c uses to select a curve, so this cannot
        // select something 4c could not. A coincident sibling endpoint may win
        // it (see EXPECTED_COINCIDENT below), which is harmless here as long as
        // what ends up selected is still a curve — that is what reveals Add
        // point, and Add point is the chrome that wraps the row.
        B.click(a.start);
        const sel = B.d.getState().selection;
        const got = B.d.getAnnotations().find(x => x.id === sel.id);
        pick = {
          found: true, askedSeq: a.seq,
          selectedSeq: got ? got.seq : null,
          selectedCurved: !!got && got.type === 'curved',
          addPointShown: !document.getElementById('toolAddPoint').hidden,
          viewport: document.documentElement.clientWidth,
        };
      });
    B.clearSelection();
    await B.settle();
    return { row, pick };
  })()`);
  // Back to the suite's own viewport before anything else runs: every section
  // below recomputes its coordinates, but leaving a narrower board behind would
  // silently change what they are pressing on.
  await s.cdp('Emulation.clearDeviceMetricsOverride', {});
  await s.eval(`window.__BI.settle()`);

  const reflow = { panel: panelRow, curved: curvedResult.row, curvedPick: curvedResult.pick };
  console.log('board-interaction-check: chrome reflow ' + JSON.stringify(reflow));
  check(reflow.curvedPick.viewport === REFLOW_HEIGHT_WIDTH,
    `the height-axis scenario needed a ${REFLOW_HEIGHT_WIDTH}px viewport but ran at ${reflow.curvedPick.viewport}px — `
    + `the device-metrics override did not take, so the measurement above does not apply`);
  check(reflow.curvedPick.found,
    'no curved line on this board, so the HEIGHT-axis reflow scenario could not run — it must not skip silently');
  check(reflow.curvedPick.selectedCurved,
    `the press meant to select curved POM ${reflow.curvedPick.askedSeq} left POM ${reflow.curvedPick.selectedSeq} selected `
    + `instead, and it is not curved — re-aim it, or the height scenario tests nothing`);
  check(reflow.curvedPick.addPointShown,
    `selecting curved POM ${reflow.curvedPick.selectedSeq} did not reveal the Add point button — that button is the extra `
    + `chrome that wraps the toolbar row, so without it this scenario cannot move the canvas top`);
  // The height/top axis, said out loud. The vacuous guard in the loop below is
  // satisfied by a width change alone, so on its own it would let this section
  // drift back to measuring one axis while claiming two. If the toolbar ever
  // stops wrapping here, this goes red and whoever reads it can either re-point
  // it at whatever does move the canvas vertically, or — if nothing can any
  // more — replace it with that fact, measured.
  check(reflow.curved.canvasHeightDelta !== 0 || reflow.curved.canvasTopDelta !== 0,
    `selecting a curved line no longer changes the canvas HEIGHT or TOP (${JSON.stringify(reflow.curved)}) — the axis `
    + `ADR 0051 was about is unproven again. Measured 2026-08-21 at ${REFLOW_HEIGHT_WIDTH}px: top +35.5, height -35.5.`);
  for (const row of [reflow.panel, reflow.curved]) {
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

  // ---- 4c. US-093 / ADR 0053: a curve can grow interior anchor points ----
  // Walks the whole grilling-session design through real gestures: the Add
  // point button appears the instant a curve is selected; clicking the curve
  // inserts an anchor exactly on the existing path (no jump) AND leaves the
  // whole drawn path where it was (shape-preserving, the claim de Casteljau
  // subdivision actually makes); a plain drag of
  // one of the new anchor's handles mirrors the opposite one (angle only, not
  // length); holding Alt breaks that pairing for one drag; a later plain drag
  // re-mirrors it (no state persists from the break); selecting the anchor
  // then Backspace removes just it; Backspace again with no anchor active
  // still deletes the whole line, unchanged from before this story.
  const addPoint = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    const before = B.d.getAnnotations().find(x => x.type === 'curved' && x.control1 && x.control2);
    if (!before) return { skipped: true };

    B.click(before.start);
    const addPointVisibleOnSelect = !document.getElementById('toolAddPoint').hidden;
    document.getElementById('toolAddPoint').click();
    const toolAfterClick = window.__braAutoModeDebug.getState().tool;

    const bez = (a, t) => {
      const u = 1 - t;
      return {
        x: u*u*u*a.start.x + 3*u*u*t*a.control1.x + 3*u*t*t*a.control2.x + t*t*t*a.end.x,
        y: u*u*u*a.start.y + 3*u*u*t*a.control1.y + 3*u*t*t*a.control2.y + t*t*t*a.end.y,
      };
    };
    // US-093 / ADR 0053 code review, 2026-08-21. Three changes here, all so the
    // insertion is measured rather than assumed:
    //
    // 1. t = 0.4271, not 0.5. The click t is aimed at the REPLACED search: it
    //    took the nearest of 25 sampled VERTICES per segment at a fixed n = 24,
    //    so t = 0.5 was vertex 12/24 and it returned that click verbatim — the
    //    "no jump" assertion passed by coincidence of the fixture. 0.4271 sits a
    //    quarter of the way into a chord of that same n = 24 grid, ~1.1 world px
    //    (2.3 screen px) from its nearest vertex, which is what makes the
    //    negative control below bite. The shipped search measures distance to
    //    the CHORDS and recovers t by projection inside the winning one, at
    //    curveChordSampleCount(seg) chords (src/curves.js; 24 is only its
    //    floor), so its accuracy no longer depends on where in the sample grid
    //    the click falls — this check's power does not move with that count.
    // 2. Click an INTEGER screen pixel and ask the harness which world point the
    //    app therefore receives. MouseEventInit types clientX as a C-style long, so a
    //    fractional click is rounded — up to 0.33 world px, which is larger than
    //    everything this section is trying to measure.
    // 3. Sample the DRAWN path either side of the insertion, 96 chords per
    //    Bézier segment. The click-to-anchor distance only ever said "the anchor
    //    sits where the TD clicked"; an insertCurveAnchorAt that wrote
    //    { point, handleIn, handleOut } all equal to the click and left
    //    control1/control2 alone would measure ~0px there and pass while
    //    reshaping the curve along its entire length.
    const wantedScreen = B.w2s(bez(before, 0.4271));
    const clickScreen = { x: Math.round(wantedScreen.x), y: Math.round(wantedScreen.y) };
    const clickPoint = B.s2w(clickScreen.x, clickScreen.y);
    const preInsert = B.d.getAnnotations().find(x => x.id === before.id);
    const legacyMid = !!preInsert.midPoint;
    const pathBefore = B.pathPoints(preInsert, 96);
    B.ev('mousedown', clickScreen.x, clickScreen.y);
    B.ev('mouseup', clickScreen.x, clickScreen.y);
    const z = B.d.getView().zoom;

    const withPoint = B.d.getAnnotations().find(x => x.id === before.id);
    const anchor = withPoint.points[0];
    const insertJumpPx = anchor ? +(Math.hypot(anchor.point.x - clickPoint.x, anchor.point.y - clickPoint.y) * z).toFixed(3) : -1;
    // How far the click itself was from the drawn path: the anchor cannot be
    // closer to the click than this, so it is the floor insertJumpPx is measured
    // against instead of a bare 0.5px.
    const clickToPathPx = +(B.pathDist(clickPoint, pathBefore) * z).toFixed(3);
    const anchorOffPathPx = anchor ? +(B.pathDist(anchor.point, pathBefore) * z).toFixed(3) : -1;
    const shapeDriftPx = anchor ? +(B.pathShift(pathBefore, B.pathPoints(withPoint, 96)) * z).toFixed(3) : -1;
    const segsAfter = anchor ? withPoint.points.length + 1 : 0;

    // Back to Select before touching handles — "Add point" stays armed
    // (US-093: a persistent mode like every other tool) and would otherwise
    // read the next click as another insertion, not a handle grab.
    document.getElementById('toolSelect').click();

    const inLenBefore = Math.hypot(anchor.handleIn.x - anchor.point.x, anchor.handleIn.y - anchor.point.y);
    B.drag(anchor.handleOut, 40, -10);
    const afterPlainDrag = B.d.getAnnotations().find(x => x.id === before.id).points[0];
    const vOut = { x: afterPlainDrag.handleOut.x - afterPlainDrag.point.x, y: afterPlainDrag.handleOut.y - afterPlainDrag.point.y };
    const vIn = { x: afterPlainDrag.handleIn.x - afterPlainDrag.point.x, y: afterPlainDrag.handleIn.y - afterPlainDrag.point.y };
    const outLen = Math.hypot(vOut.x, vOut.y), inLen = Math.hypot(vIn.x, vIn.y);
    // Collinear + opposite direction: cross product ~0 (parallel) and a
    // negative dot product (pointing away from each other through the point).
    const cross = vOut.x * vIn.y - vOut.y * vIn.x;
    const dot = vOut.x * vIn.x + vOut.y * vIn.y;
    const mirroredAngle = Math.abs(cross) / (outLen * inLen) < 0.01 && dot < 0;
    const lengthPreserved = Math.abs(inLen - inLenBefore) < 0.5;

    // Alt+drag breaks the pairing for this one drag: the OTHER handle must
    // not move at all.
    const beforeAlt = { x: afterPlainDrag.handleIn.x, y: afterPlainDrag.handleIn.y };
    B.drag(afterPlainDrag.handleOut, -20, 30, { altKey: true });
    const afterAlt = B.d.getAnnotations().find(x => x.id === before.id).points[0];
    const altBrokeIt = Math.hypot(afterAlt.handleIn.x - beforeAlt.x, afterAlt.handleIn.y - beforeAlt.y) < 0.01;

    // A later PLAIN drag re-mirrors — proves no "broken" flag was stored.
    B.drag(afterAlt.handleOut, 3, 3);
    const afterReMirror = B.d.getAnnotations().find(x => x.id === before.id).points[0];
    const reMirrored = Math.hypot(afterReMirror.handleIn.x - afterAlt.handleIn.x, afterReMirror.handleIn.y - afterAlt.handleIn.y) > 0.01;

    // Select the anchor itself, then Backspace removes just it.
    B.click(afterReMirror.point);
    const linesBeforeDelete = B.d.getAnnotations().length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    const afterAnchorDelete = B.d.getAnnotations().find(x => x.id === before.id);
    const anchorDeletedAlone = !!afterAnchorDelete && afterAnchorDelete.points.length === 0
      && B.d.getAnnotations().length === linesBeforeDelete;

    // Backspace again with no anchor active must delete the WHOLE line,
    // exactly as before this story.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    const wholeLineDeleted = !B.d.getAnnotations().some(x => x.id === before.id);

    await B.restore();
    return {
      skipped: false, seq: before.seq,
      addPointVisibleOnSelect, toolAfterClick, insertJumpPx,
      clickToPathPx, anchorOffPathPx, legacyMid, shapeDriftPx, segsAfter,
      mirroredAngle, lengthPreserved, altBrokeIt, reMirrored,
      anchorDeletedAlone, wholeLineDeleted,
    };
  })()`);
  if (addPoint.skipped) {
    console.log('board-interaction-check: no curved line on this board, Add point check skipped');
  } else {
    check(addPoint.addPointVisibleOnSelect,
      `POM ${addPoint.seq}: the Add point button must show the instant a curved line is selected`);
    check(addPoint.toolAfterClick === 'add-point',
      `clicking Add point must enter the add-point tool, got ${addPoint.toolAfterClick}`);
    // Three separate claims, and they are not interchangeable. The first two are
    // about WHERE THE ANCHOR SITS — on the path, and at the point of the path
    // nearest the click rather than at the nearest sampled vertex, which is the
    // failure mode nearestPointOnCurve's segment-based rewrite fixed. Neither
    // says anything at all about the curve's shape.
    check(addPoint.anchorOffPathPx >= 0 && addPoint.anchorOffPathPx < 0.5,
      `POM ${addPoint.seq}: the new anchor sits ${addPoint.anchorOffPathPx}px off the curve's own drawn path — insertion must land ON the path, never at the raw click pixel`);
    check(addPoint.insertJumpPx >= 0 && addPoint.insertJumpPx <= addPoint.clickToPathPx + 0.5,
      `POM ${addPoint.seq}: the click was ${addPoint.clickToPathPx}px from the path but the anchor landed ${addPoint.insertJumpPx}px from the click — it must land at the NEAREST point of the path, not snap to a sampled vertex`);
    // And the third is about THE SHAPE, sampled independently of parameter — the
    // claim de Casteljau subdivision makes and the only one that would catch an
    // insertion that moved the drawn line while leaving the anchor on the click.
    //
    // Negative controls, computed on POM 9's real control points at this
    // fixture's zoom (2.139), 2026-08-21:
    //   correct de Casteljau insertion        shape 0.0012px  jump 0.385px
    //   anchor point+both handles = the click,
    //     control1/control2 left alone        shape 0.9370px  jump 0.000px
    //   the replaced vertex-snapping search
    //     (its own fixed n = 24)              shape 0.0012px  jump 2.285px
    // The broken insertion passes both position checks and fails only the shape
    // check; the vertex-snapping search fails only the jump check — and it
    // failed NOTHING while the click sat at t = 0.5, vertex 12/24 of its grid.
    // Each of the three checks is load-bearing on its own.
    check(addPoint.legacyMid === false,
      `POM ${addPoint.seq} carries the legacy midPoint model, which the harness path sampler does not reproduce — the shape measurement below would be reading the wrong curve`);
    check(addPoint.segsAfter === 2,
      `POM ${addPoint.seq}: one insertion should leave two Bézier segments, got ${addPoint.segsAfter} — the shape measurement is not comparing what it thinks it is`);
    check(addPoint.shapeDriftPx >= 0 && addPoint.shapeDriftPx < 0.5,
      `POM ${addPoint.seq}: inserting a point moved the DRAWN path by up to ${addPoint.shapeDriftPx}px somewhere along its length — insertion must be shape-preserving everywhere, not just at the click`);
    check(addPoint.mirroredAngle,
      `POM ${addPoint.seq}: a plain drag of one handle must keep the opposite handle collinear through the anchor (no kink)`);
    check(addPoint.lengthPreserved,
      `POM ${addPoint.seq}: mirroring must preserve the OTHER handle's own length — only its angle is forced`);
    check(addPoint.altBrokeIt,
      `POM ${addPoint.seq}: holding Alt while dragging a handle must leave the opposite handle untouched`);
    check(addPoint.reMirrored,
      `POM ${addPoint.seq}: a later plain drag must re-mirror the anchor — no state may persist from the Alt-break`);
    check(addPoint.anchorDeletedAlone,
      `POM ${addPoint.seq}: selecting the anchor then Backspace must remove just that anchor, leaving the line intact`);
    check(addPoint.wholeLineDeleted,
      `POM ${addPoint.seq}: Backspace with no anchor active must still delete the whole line, unchanged from before US-093`);
    console.log(`board-interaction-check: curve anchor add/mirror/Alt-break/delete all correct (POM ${addPoint.seq}, `
      + `click ${addPoint.clickToPathPx}px off the path, anchor ${addPoint.insertJumpPx}px from the click and `
      + `${addPoint.anchorOffPathPx}px off the path, drawn path moved ${addPoint.shapeDriftPx}px)`);
  }

  // ---- 4d. Regression: interior anchors must follow a whole-line move ----
  // Code-review finding, 2026-08-21: moveAnnotation (pointer-events.js) walks
  // a fixed field list (start/end/midPoint*/control1/control2) that predates
  // ann.points (US-093) and never mentions it. Before the fix, dragging a
  // curve's body — or the photo it sits on, which drags every line on it via
  // the same function — moved every fixed field but left an interior anchor
  // frozen at its old absolute position, tearing the curve at the anchor.
  const anchorMove = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    const before = B.d.getAnnotations().find(x => x.type === 'curved' && x.control1 && x.control2);
    if (!before) return { skipped: true };

    B.click(before.start);
    document.getElementById('toolAddPoint').click();
    const bez = (a, t) => {
      const u = 1 - t;
      return {
        x: u*u*u*a.start.x + 3*u*u*t*a.control1.x + 3*u*t*t*a.control2.x + t*t*t*a.end.x,
        y: u*u*u*a.start.y + 3*u*u*t*a.control1.y + 3*u*t*t*a.control2.y + t*t*t*a.end.y,
      };
    };
    B.click(bez(before, 0.5));
    document.getElementById('toolSelect').click();
    const withAnchor = B.d.getAnnotations().find(x => x.id === before.id);
    if (!withAnchor.points.length) return { skipped: true };

    // Deselect, then drag the body from t=0.15 — clear of the t=0.5 anchor's
    // grab radius. Insertion is shape-preserving (De Casteljau), so this
    // point (from the PRE-insertion control1/control2) is still exactly on
    // the rendered curve, the same technique section 4c uses to prove the
    // insertion itself didn't jump.
    B.clearSelection();
    const s0 = { x: withAnchor.start.x, y: withAnchor.start.y };
    const a0 = { x: withAnchor.points[0].point.x, y: withAnchor.points[0].point.y };
    B.drag(bez(before, 0.15), 30, 20);
    const after = B.d.getAnnotations().find(x => x.id === before.id);
    const startDelta = { x: after.start.x - s0.x, y: after.start.y - s0.y };
    const anchorDelta = { x: after.points[0].point.x - a0.x, y: after.points[0].point.y - a0.y };

    await B.restore();
    return {
      skipped: false, seq: before.seq,
      lineMoved: Math.hypot(startDelta.x, startDelta.y) > 1,
      trackedTogether: Math.hypot(anchorDelta.x - startDelta.x, anchorDelta.y - startDelta.y) < 0.5,
    };
  })()`);
  if (anchorMove.skipped) {
    console.log('board-interaction-check: no curved line on this board, anchor-follows-move check skipped');
  } else {
    check(anchorMove.lineMoved,
      `POM ${anchorMove.seq}: the body drag never moved the line — nothing was tested`);
    check(anchorMove.trackedTogether,
      `POM ${anchorMove.seq}: dragging the line's body must move an interior anchor by the same delta as its endpoints — the curve must not tear at the anchor`);
    console.log(`board-interaction-check: an interior anchor follows a whole-line body drag (POM ${anchorMove.seq})`);
  }

  // ---- 4e. Regression: interior anchors must follow a photo resize ----
  // Same root cause as 4d, on the scale path: scaleAnnotationAbout
  // (viewport.js) scales start/end/control1/control2 about the resize
  // origin but, before the fix, left an interior anchor unscaled — silently
  // changing that POM's measured length, breaking the ADR-0051/US-091
  // "resizing the sketch changes no measured value" invariant for exactly
  // the lines this story lets a TD reshape.
  const anchorResize = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    await B.settle();
    const before = B.d.getAnnotations().find(x => x.type === 'curved' && x.control1 && x.control2);
    if (!before) return { skipped: true };

    B.click(before.start);
    document.getElementById('toolAddPoint').click();
    const bez = (a, t) => {
      const u = 1 - t;
      return {
        x: u*u*u*a.start.x + 3*u*u*t*a.control1.x + 3*u*t*t*a.control2.x + t*t*t*a.end.x,
        y: u*u*u*a.start.y + 3*u*u*t*a.control1.y + 3*u*t*t*a.control2.y + t*t*t*a.end.y,
      };
    };
    B.click(bez(before, 0.5));
    document.getElementById('toolSelect').click();
    const withAnchor = B.d.getAnnotations().find(x => x.id === before.id);
    if (!withAnchor.points.length) return { skipped: true };
    B.clearSelection();
    await B.settle();

    const s0 = { x: withAnchor.start.x, y: withAnchor.start.y };
    const a0 = { x: withAnchor.points[0].point.x, y: withAnchor.points[0].point.y };
    const beforeW = B.d.getImages()[0].width;

    // Same "widest clear spot" + corner-drag technique as the resize check
    // above, so the corner press reliably opens a resize, not a marquee or
    // a line drag.
    const im = B.d.getImages()[0];
    let spot = null, bestClear = -1;
    for (let gx = 1; gx <= 14; gx += 1) for (let gy = 1; gy <= 14; gy += 1) {
      const p = { x: im.x + im.width * gx / 15, y: im.y + im.height * gy / 15 };
      let clear = Infinity;
      for (const a of B.d.getAnnotations()) {
        const vx = a.end.x - a.start.x, vy = a.end.y - a.start.y;
        const len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.start.x) * vx + (p.y - a.start.y) * vy) / len2));
        clear = Math.min(clear, Math.hypot(p.x - (a.start.x + vx * t), p.y - (a.start.y + vy * t)));
      }
      if (clear > bestClear) { bestClear = clear; spot = p; }
    }
    const mid = B.w2s(spot);
    B.ev('mousedown', mid.x, mid.y); B.ev('mouseup', mid.x, mid.y);
    await B.settle();
    const se = B.w2s({ x: im.x + im.width, y: im.y + im.height });
    B.ev('mousedown', se.x, se.y);
    for (let i = 1; i <= 6; i += 1) B.ev('mousemove', se.x + 120 * i / 6, se.y + 90 * i / 6);
    B.ev('mouseup', se.x + 120, se.y + 90);
    await B.settle();

    const imgScale = B.d.getImages()[0].width / beforeW;
    const after = B.d.getAnnotations().find(x => x.id === before.id);
    const relBefore = { x: a0.x - s0.x, y: a0.y - s0.y };
    const relAfter = { x: after.points[0].point.x - after.start.x, y: after.points[0].point.y - after.start.y };
    const expected = { x: relBefore.x * imgScale, y: relBefore.y * imgScale };
    const err = Math.hypot(relAfter.x - expected.x, relAfter.y - expected.y);
    const relBeforeMag = Math.hypot(relBefore.x, relBefore.y);

    await B.restore();
    return {
      skipped: false, seq: before.seq, imgScale: +imgScale.toFixed(4),
      resized: imgScale > 1.05,
      anchorScaledWithLine: err < Math.max(0.5, relBeforeMag * 0.01),
    };
  })()`);
  if (anchorResize.skipped) {
    console.log('board-interaction-check: no curved line on this board, anchor-follows-resize check skipped');
  } else {
    check(anchorResize.resized,
      `POM ${anchorResize.seq}: the photo barely resized (x${anchorResize.imgScale}) — nothing was tested`);
    check(anchorResize.anchorScaledWithLine,
      `POM ${anchorResize.seq}: resizing the photo must scale an interior anchor by the same factor as its endpoints (x${anchorResize.imgScale}) — the curve must not distort`);
    console.log(`board-interaction-check: an interior anchor follows photo resize x${anchorResize.imgScale} (POM ${anchorResize.seq})`);
  }

  // ---- 4f. US-093 / ADR 0053: which of two overlapping handles a press takes ----
  // Round-1 code-review finding, 2026-08-21: handle ARBITRATION had no coverage
  // at all. Section 4c only ever presses EXACT handle positions, where the
  // distance is 0 and first-match, nearest-wins and "biggest target first" are
  // indistinguishable — which is precisely how a first-match hit test shipped
  // and sat green. Each case below presses BETWEEN two handles whose catch zones
  // overlap, and asserts which one the press opened.
  //
  // Every case names the RIVAL rule it separates from and asserts that rival's
  // answer too, so the case cannot quietly stop discriminating: if the fixture's
  // geometry drifts until both rules agree, the rival assertion goes red and
  // says so instead of passing on a press that proves nothing.
  //
  // Measured on POM 9 / demo1, 2026-08-21 (zoom 2.139, endpoint radius 14px,
  // control radius 11px). Each press sits ~3px from the winner and ~6px from
  // the loser, so both are well inside their radii:
  //
  //   press between                    shipped answer    rival answer
  //   point0.handleOut / point1.point   point1.point      point0.handleOut  (first-match)
  //   point1.point / point0.handleOut   point0.handleOut  point1.point      (biggest-first)
  //   control1 / point0.point           point0.point      control1          (first-match)
  //   start / point0.point              point0.point      start             (first-match)
  const arbitration = await s.eval(`(async () => {
    const B = window.__BI;
    const rows = [];
    const curve = () => B.d.getAnnotations().find(x => x.type === 'curved' && x.control1 && x.control2);
    const zoom = () => B.d.getView().zoom;

    // Grow the fixture curve the anchors a case needs. The insertion points are
    // computed on the PRE-insertion single cubic: insertion is shape-preserving
    // (proved in 4c), so those world points are still exactly on the drawn path
    // after each one, the same technique 4d/4e use.
    const grow = (ts) => {
      const base = curve();
      B.click(base.start);
      document.getElementById('toolAddPoint').click();
      for (const t of ts) B.click(B.onGeom(base, t));
      document.getElementById('toolSelect').click();
      return { base: base, ann: curve() };
    };
    // A world point 'gap' SCREEN px from 'anchorPt', pushed perpendicular to the
    // direction 'along' — so the handle being moved lands clear of whatever else
    // lies on that tangent (an anchor carries its own two handles along it), and
    // the only candidates in range are the pair under test.
    const besidePoint = (anchorPt, along, gapPx) => {
      const len = Math.hypot(along.x, along.y) || 1;
      const g = gapPx / zoom();
      return { x: anchorPt.x - (along.y / len) * g, y: anchorPt.y + (along.x / len) * g };
    };
    const probe = (label, ann, fromPart, toPart, want, rival) => {
      const pick = B.findRivalPress(ann, fromPart, toPart, want, rival);
      if (!pick) {
        rows.push({ label: label, found: false, seq: ann.seq, want: want, rival: rival,
          targets: B.scoreHandles(ann, B.partPoint(ann, toPart)) });
        return;
      }
      const got = B.pressPart(pick.screen);
      rows.push({ label: label, found: true, seq: ann.seq, want: want, rival: rival,
        rivalSays: pick.rivalSays, got: got ? got.part : null, gotType: got ? got.type : null,
        gotId: got ? got.id : null, annId: ann.id, f: pick.f, margin: pick.margin, near: pick.near });
    };

    // (a) An anchor's bend handle against the NEXT anchor's point. On this
    // fixture the two sit far apart, so the crowding a TD meets on a tight curve
    // is built by dragging the handle into range — a supported gesture, and the
    // one 4c already exercises.
    await B.restore();
    B.clearSelection();
    let ann = grow([0.35, 0.65]).ann;
    const a0 = ann.points[0], a1 = ann.points[1];
    let along = { x: a1.handleOut.x - a1.handleIn.x, y: a1.handleOut.y - a1.handleIn.y };
    const builtA = {
      anchors: ann.points.length,
      grabbed: B.dragHandleTo(a0.handleOut, besidePoint(a1.point, along, 9)),
    };
    ann = curve();
    builtA.gapPx = +(Math.hypot(ann.points[0].handleOut.x - ann.points[1].point.x,
      ann.points[0].handleOut.y - ann.points[1].point.y) * zoom()).toFixed(2);
    // The direction that matters: the anchor POINT is offered LAST of the two,
    // so a first-match rule hands it to the bend handle that came first.
    probe('an anchor point beats the previous anchor bend handle', ann,
      'point0.handleOut', 'point1.point', 'point1.point', 'legacy-first');
    // And the other direction: a press nearer the bend handle must stay with it,
    // which is what rules out "the bigger painted target always wins".
    probe('a bend handle keeps a press that is nearer to it', ann,
      'point1.point', 'point0.handleOut', 'point0.handleOut', 'point-tier');

    // (b) An anchor inside control1's catch radius. control1 is offered before
    // any anchor, so first-match gave it the press however close the anchor was.
    await B.restore();
    B.clearSelection();
    ann = grow([0.5]).ann;
    let p0 = ann.points[0];
    along = { x: p0.handleOut.x - p0.handleIn.x, y: p0.handleOut.y - p0.handleIn.y };
    const builtB = { anchors: ann.points.length,
      grabbed: B.dragHandleTo(ann.control1, besidePoint(p0.point, along, 9)) };
    ann = curve();
    builtB.gapPx = +(Math.hypot(ann.control1.x - ann.points[0].point.x,
      ann.control1.y - ann.points[0].point.y) * zoom()).toFixed(2);
    probe('an anchor point beats control1', ann,
      'control1', 'point0.point', 'point0.point', 'legacy-first');

    // (c) An anchor DRAGGED next to the line start — the defect round 2 fixed.
    // The endpoints used to be tested first AND at the wider radius, so a press
    // 1px from the anchor and 13px from start moved the POM endpoint off its
    // landmark pin and changed the measured length. It has to be a drag, not an
    // insertion: handleAddPointClick refuses a landing spot this close to an end
    // (asserted in 4h), which is why the two gates are not interchangeable.
    await B.restore();
    B.clearSelection();
    ann = grow([0.5]).ann;
    p0 = ann.points[0];
    along = { x: ann.control1.x - ann.start.x, y: ann.control1.y - ann.start.y };
    const builtC = { anchors: ann.points.length,
      grabbed: B.dragHandleTo(p0.point, besidePoint(ann.start, along, 10)) };
    ann = curve();
    builtC.gapPx = +(Math.hypot(ann.points[0].point.x - ann.start.x,
      ann.points[0].point.y - ann.start.y) * zoom()).toFixed(2);
    probe('an anchor point beats the line start it sits next to', ann,
      'start', 'point0.point', 'point0.point', 'legacy-first');

    await B.restore();
    return { rows: rows, builtA: builtA, builtB: builtB, builtC: builtC,
      endpointRadiusPx: window.__BI_GATE.endpointRadiusPx,
      controlRadiusPx: window.__BI_GATE.controlRadiusPx };
  })()`);
  console.log('board-interaction-check: arbitration built '
    + JSON.stringify({ a: arbitration.builtA, b: arbitration.builtB, c: arbitration.builtC }));
  console.log('board-interaction-check: arbitration ' + JSON.stringify(arbitration.rows));
  for (const built of [['a', arbitration.builtA, 2], ['b', arbitration.builtB, 1], ['c', arbitration.builtC, 1]]) {
    check(built[1].anchors === built[2],
      `arbitration case ${built[0]}: the fixture grew ${built[1].anchors} interior anchors, not ${built[2]} — `
      + `the insertions the case is built on did not all land`);
    // The scenario has to be BUILT from the handle it meant to move. A press
    // that grabbed something else would leave two handles still far apart and
    // the probe below would then find no overlap at all — reported here, where
    // the cause is visible, rather than as a mystery "no discriminating press".
    check(built[1].grabbed && built[1].grabbed.type === 'drag-handle',
      `arbitration case ${built[0]}: the setup drag opened ${JSON.stringify(built[1].grabbed)} instead of a handle drag`);
    check(built[1].gapPx > 0 && built[1].gapPx <= arbitration.endpointRadiusPx,
      `arbitration case ${built[0]}: the two competing handles ended ${built[1].gapPx} screen px apart, which is outside `
      + `the ${arbitration.endpointRadiusPx}px endpoint radius — the catch zones do not overlap, so nothing is being arbitrated`);
  }
  for (const row of arbitration.rows) {
    check(row.found,
      `arbitration (${row.label}): no press between those two handles separates nearest-wins from ${row.rival} on POM ${row.seq}. `
      + `The case tests nothing as written — re-aim it. Candidate distances at the target: ${JSON.stringify(row.targets)}`);
    check(row.gotType === 'drag-handle' && row.gotId === row.annId,
      `arbitration (${row.label}): the press opened ${row.gotType} on ${row.gotId} instead of a handle drag on POM ${row.seq}`);
    check(row.got === row.want,
      `arbitration (${row.label}): POM ${row.seq} handed the press to '${row.got}', expected '${row.want}'. `
      + `Nearest distances at that pixel: ${JSON.stringify(row.near)}`);
    // The negative control, said out loud: this exact pixel is one the rival
    // rule answers DIFFERENTLY, and this is the number that proves the
    // assertion above can fail. If a geometry change ever makes the two rules
    // agree here, this goes red rather than leaving a vacuous pass behind.
    check(row.rivalSays !== row.want,
      `arbitration (${row.label}): ${row.rival} would also answer '${row.want}' at that pixel, so the assertion above `
      + `cannot distinguish the two rules any more — find a press where they differ`);
    // Both candidates in range, and the loser is exactly the one the rival rule
    // would have handed the press to. Without this the case could degenerate
    // into "the press was basically on the winner", which is section 4c again.
    check(row.near.length >= 2 && row.near[1].part === row.rivalSays,
      `arbitration (${row.label}): the runner-up at that pixel was ${JSON.stringify(row.near)}, so the press is not `
      + `between the two handles under test`);
    check(Math.abs(row.f - 0.5) <= 0.15,
      `arbitration (${row.label}): the only separating press sits at ${row.f} of the way between the two handles, not `
      + `near midway — the two are no longer really competing there`);
  }
  console.log('board-interaction-check: nearest-wins arbitration holds for '
    + arbitration.rows.map(r => r.want + ' over ' + r.rivalSays).join(', '));

  // ---- 4g. US-093 / ADR 0053: the POM callout holds still across insertions ----
  // Round-1 code-review finding, 2026-08-21: nothing anywhere looked at
  // ann.label after an insertion, and the defect that slipped through was a 95px
  // teleport of the POM NUMBER — computeDefaultLabelPosition picked the middle
  // ENTRY of ann.points instead of the middle of the path, so one anchor 20%
  // along POM 18's armhole curve moved the number onto that anchor and left it
  // there. handleAddPointClick writes the result into ann.label, so it shipped
  // in Copy Image, Export PDF and the Excel embedded PNG. Every gate passed.
  //
  // The old rule was also non-monotonic in anchor count — floor((n - 1) / 2)
  // resolves 1 and 2 anchors to points[0] and 3 and 4 to points[1] — so the
  // multi-anchor rows are the ones that catch a regression to it. Both the
  // shipped position and what the old rule WOULD have produced are computed at
  // every step, which is the negative control: the old-rule column has to be
  // large where the shipped column is small, or this section is not a gate.
  //
  // Measured on POM 9 / demo1, 2026-08-21, screen px, shipped vs old rule at
  // 1 / 2 / 3 / 4 anchors:
  //
  //                            shipped                  old middle-entry rule
  //   off its own arc mid   0.09 0.13 0.04 0.03      61.05 61.06  6.86  6.86
  //   from the 1-anchor spot   -  0.21 0.12 0.06          -     0 54.21 54.21
  //
  // Which is why all three claims are asserted and not just one: the
  // "stays put" row cannot see the old rule at 1 or 2 anchors (both resolve to
  // points[0], so it does not move BETWEEN them), and only the third anchor
  // exposes the 54px jump. The off-arc-mid row catches it at every count.
  //
  // One thing writing this section turned up and did NOT fix, because it is a
  // different defect in the same path: the number does not hold entirely still.
  // See the movedFromBasePx assertion below for the measurement.
  //
  // Only asserted for labelManual === false. A TD-positioned label is
  // deliberately left alone by handleAddPointClick, so it has nothing to prove.
  const callout = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    await B.settle();
    const base = B.d.getAnnotations().find(x => x.type === 'curved' && x.control1 && x.control2);
    if (!base) return { skipped: true };
    const z = B.d.getView().zoom;
    const curve = () => B.d.getAnnotations().find(x => x.id === base.id);
    const px = (p, q) => +(Math.hypot(p.x - q.x, p.y - q.y) * z).toFixed(3);
    // computeDefaultLabelPosition's offset: 20 screen px along the normal, i.e.
    // the tangent rotated by -90 degrees. cos(a - PI/2) = sin(a) and
    // sin(a - PI/2) = -cos(a), so the offset is (ty, -tx) / |t| * 20 / zoom.
    const offsetFrom = (point, tan) => {
      const len = Math.hypot(tan.x, tan.y) || 1;
      const o = 20 / z;
      return { x: point.x + (tan.y / len) * o, y: point.y - (tan.x / len) * o };
    };
    // Where the number belongs: the half-arc-length point of the DRAWN path,
    // sampled far more finely than the app does, so this reference is the
    // geometry rather than a re-run of the code under test.
    const arcLabel = (a) => {
      const poly = B.pathPoints(a, 400);
      let total = 0;
      for (let i = 1; i < poly.length; i += 1) total += Math.hypot(poly[i].x - poly[i-1].x, poly[i].y - poly[i-1].y);
      let walked = 0;
      for (let i = 1; i < poly.length; i += 1) {
        const seg = Math.hypot(poly[i].x - poly[i-1].x, poly[i].y - poly[i-1].y);
        if (walked + seg >= total / 2) {
          const t = seg > 0 ? (total / 2 - walked) / seg : 0;
          return offsetFrom(
            { x: poly[i-1].x + (poly[i].x - poly[i-1].x) * t, y: poly[i-1].y + (poly[i].y - poly[i-1].y) * t },
            { x: poly[i].x - poly[i-1].x, y: poly[i].y - poly[i-1].y });
        }
        walked += seg;
      }
      return offsetFrom(poly[poly.length - 1], { x: 1, y: 0 });
    };
    // The rule this section exists to keep out: the middle ENTRY of ann.points,
    // with the tangent read off that anchor's own two handles.
    const oldRuleLabel = (a) => {
      const pts = a.points || [];
      if (!pts.length) return null;
      const pt = pts[Math.floor((pts.length - 1) / 2)];
      return offsetFrom(pt.point, { x: pt.handleOut.x - pt.handleIn.x, y: pt.handleOut.y - pt.handleIn.y });
    };

    const labelBase = { x: base.label.x, y: base.label.y };
    const refBase = arcLabel(base);
    B.click(base.start);
    document.getElementById('toolAddPoint').click();
    const rows = [];
    let labelFirst = null;
    for (const t of [0.20, 0.45, 0.65, 0.85]) {
      B.click(B.onGeom(base, t));
      const a = curve();
      if (!labelFirst) labelFirst = { x: a.label.x, y: a.label.y };
      const old = oldRuleLabel(a);
      rows.push({
        t: t, anchors: a.points.length, labelManual: !!a.labelManual,
        movedFromBasePx: px(a.label, labelBase),
        movedFromFirstPx: px(a.label, labelFirst),
        offArcMidPx: px(a.label, arcLabel(a)),
        oldRuleMovedPx: old ? px(old, labelBase) : -1,
      });
    }
    document.getElementById('toolSelect').click();
    await B.restore();
    return { skipped: false, seq: base.seq, zoom: +z.toFixed(3),
      labelManualBefore: !!base.labelManual,
      baseOffArcMidPx: px(labelBase, refBase), rows: rows };
  })()`);
  if (callout.skipped) {
    console.log('board-interaction-check: no curved line on this board, callout-position check skipped');
  } else {
    console.log('board-interaction-check: callout ' + JSON.stringify(callout));
    check(callout.labelManualBefore === false,
      `POM ${callout.seq}'s label is TD-placed (labelManual), so insertion deliberately leaves it alone and this section `
      + `cannot test the default-position rule — point it at a line whose label is still automatic`);
    for (const row of callout.rows) {
      check(row.labelManual === false,
        `POM ${callout.seq}: inserting an anchor flipped labelManual — an insertion is not a TD label placement`);
      // The printed number must not move — except by exactly the one amount it
      // is ALREADY known to move, which is measured here rather than waved at.
      //
      // MEASURED 2026-08-21, POM 9 on demo1: the callout does not sit at its own
      // default position to begin with. nudgeAutoLabelsToAvoidCollisions
      // (label-layout.js) runs once at Apply and pushed this number 14.573
      // screen px off the half-arc-length point to clear a neighbouring POM's
      // number; handleAddPointClick then recomputes ann.label from scratch and
      // discards that nudge, so the FIRST insertion moves the number 14.53px
      // back to the un-nudged spot and every later one holds it there (14.66,
      // 14.61, 14.56). That is a real, separate defect in this same path — an
      // insertion can drop the number back on top of a neighbour's — and it is
      // NOT the defect round 1 fixed, which was 71.8px on the first anchor and a
      // second jump to 19.7px on the third. Asserted as "the move equals the
      // discarded nudge and nothing more" so both stay visible: the teleport
      // regression reads 71.8 against a 14.57 nudge and goes red, while the
      // known deviation is stated with its number instead of being hidden inside
      // a loose tolerance. Whoever fixes the nudge-preservation drops this to
      // `row.movedFromBasePx < 1.5`.
      check(Math.abs(row.movedFromBasePx - callout.baseOffArcMidPx) < 1.5,
        `POM ${callout.seq}: inserting anchor ${row.anchors} at t=${row.t} moved the callout ${row.movedFromBasePx} screen px, `
        + `but only ${callout.baseOffArcMidPx}px of that is the Apply-time collision nudge being discarded — the rest is the `
        + `number walking off its own curve, and it ships in Copy Image, Export PDF and the Excel embedded PNG`);
      check(row.movedFromFirstPx < 1.5,
        `POM ${callout.seq}: with ${row.anchors} anchors the callout sits ${row.movedFromFirstPx} screen px from where it sat `
        + `with one — adding bends must not walk the number along the curve`);
      check(row.offArcMidPx < 1.5,
        `POM ${callout.seq}: with ${row.anchors} anchors the callout is ${row.offArcMidPx} screen px off the half-arc-length `
        + `point of its own drawn path, which is where the number belongs`);
      // Negative control: the same geometry, scored against the rule that
      // shipped the bug. If this ever comes out small, the rows above stop
      // being able to tell the two rules apart and say so here.
      check(row.oldRuleMovedPx > 10,
        `POM ${callout.seq}: with ${row.anchors} anchors the OLD middle-entry rule would have put the callout only `
        + `${row.oldRuleMovedPx} screen px from the right place, so the assertions above no longer discriminate — `
        + `this section needs a curve (or anchor placement) where the two rules actually differ`);
    }
    console.log(`board-interaction-check: across 1-4 anchors the POM ${callout.seq} callout stays within `
      + `${Math.max(...callout.rows.map(r => r.offArcMidPx))}px of its own half-arc-length point and `
      + `${Math.max(...callout.rows.map(r => r.movedFromFirstPx))}px of where one anchor left it; the old middle-entry `
      + `rule would have been up to ${Math.max(...callout.rows.map(r => r.oldRuleMovedPx))}px out `
      + `(and non-monotonic: ${callout.rows.map(r => r.oldRuleMovedPx).join(' -> ')})`);
  }

  // ---- 4h. US-093 / ADR 0053: the three ways Add point declines ----
  // Round-1 code-review finding, 2026-08-21: the gesture now has three refusal
  // paths and all three were invisible to this suite.
  //
  //   (i)   a click that misses the curve — must toast and change nothing;
  //   (ii)  a landing spot too close to an endpoint or an existing anchor —
  //         must toast and change nothing, while the NEAREST spot that clears
  //         the gate must be accepted (the refusal half alone would pass on a
  //         button that could do nothing anywhere);
  //   (iii) the button must not be offered at all for a multi-line selection or
  //         for a line hidden by the review x Hide toggle.
  //
  // (iii) carries the most damage. With a group selected, the Backspace that
  // undoes an insertion is NOT the anchor-delete branch — deleteSelected gates
  // that on a single selection — so it falls through to the GROUP delete and
  // takes every selected POM line with it, pushing their labels into
  // state.deletedPomKeys and dropping those rows from the exported workbook.
  // That fall-through is measured here, not asserted from the source comment,
  // because it is the whole reason the predicate exists.
  //
  // The gate's own numbers are DERIVED from the served bundle (__BI_GATE), not
  // written down here: they were re-tuned twice during this review, and a
  // hard-coded value would aim at empty space on both sides of the boundary
  // while still passing. What a number cannot express is that the gate has TWO
  // halves, measured on different things — anchor spacing, and the shortest
  // handle the split would write — so each row aims at the half it names (see
  // `landings` below). Measured on POM 9 / demo1, 2026-08-21: at its 2.5px line
  // width the accept tolerance is 8 screen px and the separation gate 4. The
  // refused spots sit 1.89px and 1.91px from an occupied point; the nearest spot
  // clearing both halves is 15.5px out with 5.1px of handle (t = 0.0625) — the
  // ~3:1 ratio between the two, and why aiming by distance-to-endpoint alone
  // picked a spot the gate refuses. Every row lands 0.02px to 0.22px off the
  // path, well inside the accept tolerance, so no row is secretly a MISS.
  const refusals = await s.eval(`(async () => {
    const B = window.__BI;
    const gate = window.__BI_GATE;
    const toast = document.getElementById('toast');
    // Clear the node before every gesture: showToast QUEUES a message that
    // arrives while an earlier one is still inside its 900ms reading window, so
    // a leftover toast from a previous step would make the next read either
    // stale or empty. Read synchronously after the press — onMouseDown runs to
    // completion inside dispatchEvent, so the message is already on screen.
    const clearToast = () => { toast.classList.remove('show'); toast.textContent = ''; };
    const toastNow = () => (toast.classList.contains('show') ? String(toast.textContent || '') : '');
    const byId = (id) => B.d.getAnnotations().find(x => x.id === id);
    const anchorsOf = (id) => { const a = byId(id); return a && Array.isArray(a.points) ? a.points.length : -1; };
    const curves = () => B.d.getAnnotations().filter(x => x.type === 'curved' && x.control1 && x.control2);
    const zoom = () => B.d.getView().zoom;
    const waitUntil = async (fn) => {
      for (let i = 0; i < 40; i += 1) { if (fn()) return true; await B.settle(); }
      return false;
    };
    // handleAddPointClick's own two numbers, in SCREEN px, rebuilt from the
    // expression in the bundle: tolerance = max(floor, lineWidth / 2 + pad) and
    // minSeparation = tolerance / divisor, both divided by zoom in the app.
    const gatePx = (a) => {
      const lw = Number.isFinite(a.lineWidth) ? a.lineWidth : 2.5;
      const tolerancePx = Math.max(gate.addPointFloorPx, lw / 2 + gate.addPointWidthPadPx);
      return { tolerancePx: +tolerancePx.toFixed(3),
        minSeparationPx: +(tolerancePx / gate.addPointSeparationDivisor).toFixed(3) };
    };
    // Candidate landing spots, walked in the (segment, t) the gate would be
    // applied at rather than as bare positions — because the gate's two halves
    // are measured on different things. US-093 / ADR 0053 code review,
    // 2026-08-21: takenPx is the anchor-spacing half (distance from the
    // landing point to the nearest already-occupied point) and handleSpanPx
    // is the half that actually binds near an end — the shortest of the four
    // handles the split would write, mirroring previewCurveAnchorInsertion
    // (curves.js), which is four de Casteljau lerps. Near an end the flanking
    // handle lands at p0 + t(p1-p0) while the anchor lands near p0 + 3t(p1-p0),
    // so the handle span runs at roughly a THIRD of the anchor's clearance:
    // choosing a landing spot by its distance to the endpoint says nothing
    // about whether the gate will take it, which is exactly how the "just past
    // the gate" row below came to be aimed at a spot the gate refuses.
    const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const landings = (a, steps) => {
      const z = zoom();
      const dpx = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) * z;
      const taken = [a.start, a.end].concat((a.points || []).map(pt => pt && pt.point)).filter(Boolean);
      const out = [];
      const segs = B.curveSegs(a);
      for (let s = 0; s < segs.length; s += 1) {
        const g = segs[s];
        for (let i = 0; i <= steps; i += 1) {
          const t = i / steps;
          const p01 = lerp(g[0], g[1], t), p12 = lerp(g[1], g[2], t), p23 = lerp(g[2], g[3], t);
          const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
          const mid = lerp(p012, p123, t);
          out.push({
            seg: s, t: t, p: mid,
            handleSpanPx: +Math.min(dpx(p01, g[0]), dpx(p012, mid), dpx(p123, mid), dpx(p23, g[3])).toFixed(3),
            takenPx: +Math.min.apply(null, taken.map(q => dpx(mid, q))).toFixed(3),
          });
        }
      }
      return out;
    };
    // A landing spot whose straight-line distance to 'ref' is as close as
    // possible to wantPx screen px — for the rows that are aiming INSIDE the
    // gate, where the anchor-spacing half is what refuses them.
    const landingNear = (a, ref, wantPx) => {
      const z = zoom();
      let best = null;
      for (const c of landings(a, 400)) {
        const err = Math.abs(Math.hypot(c.p.x - ref.x, c.p.y - ref.y) * z - wantPx);
        if (!best || err < best.err) best = { c: c, err: err };
      }
      return best ? best.c : null;
    };
    // The NEAREST spot to 'ref' that clears both halves of the gate — the
    // accepted control, and a stronger claim than "somewhere out there is a
    // legal spot": the first legal spot walking in from the end must be taken.
    // The 1px margin absorbs the integer-pixel rounding of the click itself.
    const nearestLegalLanding = (a, ref, minPx) => {
      const z = zoom();
      let best = null;
      for (const c of landings(a, 400)) {
        if (c.takenPx <= minPx + 1 || c.handleSpanPx <= minPx + 1) continue;
        const d = Math.hypot(c.p.x - ref.x, c.p.y - ref.y) * z;
        if (!best || d < best.d) best = { c: c, d: d };
      }
      return best ? best.c : null;
    };
    // Click an integer pixel and report the world point the app therefore
    // received, so the distances below are the app's own and not the caller's
    // intent rounded away (MouseEventInit types clientX as a C-style long).
    const clickExact = (worldPt) => {
      const s = B.w2s(worldPt);
      const screen = { x: Math.round(s.x), y: Math.round(s.y) };
      B.ev('mousedown', screen.x, screen.y);
      B.ev('mouseup', screen.x, screen.y);
      return B.s2w(screen.x, screen.y);
    };
    const armAddPoint = (base) => {
      B.click(base.start);
      const offered = !document.getElementById('toolAddPoint').hidden;
      document.getElementById('toolAddPoint').click();
      return { offered: offered, tool: B.d.getState().tool };
    };
    // The point on a line's drawn path with the most clearance from every OTHER
    // line and every label, so a body click cannot be claimed by a neighbour
    // (hitTestAnnotations is topmost-first) — the same technique the photo and
    // resize sections use to find a press the photo will definitely take.
    // pathPoints assumes a cubic, so a straight neighbour has to be described
    // by its own two points — its control1/control2 are null and curveSegs
    // would dereference them.
    const polyOf = (a) => (a.type === 'curved' && a.control1 && a.control2)
      ? B.pathPoints(a, 24) : [a.start, a.end];
    const clearBodyPoint = (a) => {
      const others = B.d.getAnnotations().filter(x => x.id !== a.id);
      const polys = others.map(polyOf);
      let best = null;
      for (const p of B.pathPoints(a, 24)) {
        let clear = Infinity;
        for (let i = 0; i < others.length; i += 1) {
          clear = Math.min(clear, B.pathDist(p, polys[i]));
          clear = Math.min(clear, Math.hypot(p.x - others[i].label.x, p.y - others[i].label.y));
        }
        if (!best || clear > best.clear) best = { p: p, clear: clear };
      }
      return best;
    };

    // ---- (i) a click that misses the curve ----
    await B.restore();
    B.clearSelection();
    await B.settle();
    let base = curves()[0];
    if (!base) return { skipped: true };
    let g = gatePx(base);
    const armMiss = armAddPoint(base);
    // Seed ONE real insertion first, so the refused click that follows has a
    // history entry behind it to undo. That is how a refusal is proved not to
    // have deepened history without a debug hook for its depth: if the refusal
    // pushed an entry, the single undo below reverses THAT (a no-op) and the
    // seeded anchor survives. It cannot catch a refusal that pushed a
    // byte-identical snapshot, because pushHistoryIfChanged de-dupes on the
    // fingerprint — but that is precisely a refusal that changed nothing.
    B.click(B.onGeom(base, 0.5));
    const seeded = anchorsOf(base.id);
    const annsBeforeMiss = B.d.getAnnotations().length;
    clearToast();
    const missWanted = B.offGeom(base, 0.30, 60);
    const missGot = clickExact(missWanted);
    const miss = {
      seeded: seeded, tool: armMiss.tool,
      tolerancePx: g.tolerancePx,
      offPathPx: +(B.pathDist(missGot, B.pathPoints(byId(base.id), 400)) * zoom()).toFixed(2),
      toast: toastNow(),
      anchors: anchorsOf(base.id),
      anns: B.d.getAnnotations().length, annsBefore: annsBeforeMiss,
      toolAfter: B.d.getState().tool,
    };
    document.getElementById('undoBtn').click();
    miss.oneUndoReachedBase = await waitUntil(() => anchorsOf(base.id) === 0);
    miss.anchorsAfterUndo = anchorsOf(base.id);

    // ---- (ii) a landing spot the gate refuses, and one just past it ----
    const tooClose = [];
    for (const spec of [
      { label: 'the line start', wantMul: 0.5, seedAnchor: false, expectAccept: false },
      { label: 'an existing anchor', wantMul: 0.5, seedAnchor: true, expectAccept: false },
      { label: 'the nearest legal spot to the line start', nearestLegal: true, seedAnchor: false, expectAccept: true },
    ]) {
      await B.restore();
      B.clearSelection();
      await B.settle();
      base = curves()[0];
      g = gatePx(base);
      const arm = armAddPoint(base);
      let ref = base.start;
      if (spec.seedAnchor) {
        B.click(B.onGeom(base, 0.5));
        const withOne = byId(base.id);
        if (!withOne.points.length) { tooClose.push({ label: spec.label, seedFailed: true }); continue; }
        ref = { x: withOne.points[0].point.x, y: withOne.points[0].point.y };
      }
      const anchorsBefore = anchorsOf(base.id);
      const annsBefore = B.d.getAnnotations().length;
      clearToast();
      const aim = spec.nearestLegal
        ? nearestLegalLanding(byId(base.id), ref, g.minSeparationPx)
        : landingNear(byId(base.id), ref, g.minSeparationPx * spec.wantMul);
      if (!aim) { tooClose.push({ label: spec.label, aimFailed: true, minSeparationPx: g.minSeparationPx }); continue; }
      const got = clickExact(aim.p);
      tooClose.push({
        label: spec.label, offered: arm.offered, tool: arm.tool,
        minSeparationPx: g.minSeparationPx, tolerancePx: g.tolerancePx,
        wantedMul: spec.wantMul || null, expectAccept: spec.expectAccept,
        // Both halves of the gate at the spot aimed at: how far it is from the
        // nearest occupied point, and how short the shortest handle the split
        // would write would be. Plus how far the click was from the path at all,
        // which is the accept tolerance and a different test again.
        aimTakenPx: aim.takenPx, aimHandleSpanPx: aim.handleSpanPx, aimT: +aim.t.toFixed(4),
        sepPx: +(Math.hypot(got.x - ref.x, got.y - ref.y) * zoom()).toFixed(3),
        offPathPx: +(B.pathDist(got, B.pathPoints(byId(base.id), 400)) * zoom()).toFixed(3),
        toast: toastNow(),
        anchorsBefore: anchorsBefore, anchors: anchorsOf(base.id),
        anns: B.d.getAnnotations().length, annsBefore: annsBefore,
      });
    }

    // ---- (iii-a) not offered for a multi-line selection ----
    await B.restore();
    B.clearSelection();
    await B.settle();
    base = curves()[0];
    // A SECOND curved line, so the only thing disqualifying the selection is
    // that there are two of them — with a straight line as the primary the type
    // test would fire first and the case would prove nothing about the group.
    const second = curves()[1] || null;
    const multi = { hasSecondCurve: !!second };
    if (second) {
      B.click(base.start);
      multi.offeredSingle = !document.getElementById('toolAddPoint').hidden;
      const spot = clearBodyPoint(second);
      multi.clearPx = +(spot.clear * zoom()).toFixed(1);
      B.click(spot.p, { shiftKey: true });
      multi.primaryId = B.d.getState().selection.id;
      multi.secondId = second.id;
      multi.offeredGroup = !document.getElementById('toolAddPoint').hidden;
      const annsBefore = B.d.getAnnotations().length;
      document.getElementById('toolAddPoint').click();   // press it anyway
      multi.toolAfterClick = B.d.getState().tool;
      multi.anchors = anchorsOf(base.id);
      multi.anns = B.d.getAnnotations().length;
      multi.annsBefore = annsBefore;
      // The hazard, measured: Backspace on this selection is the GROUP delete.
      const delBefore = ((B.d.exportProject().state || {}).deletedPomKeys || []).length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      multi.linesDeleted = annsBefore - B.d.getAnnotations().length;
      multi.deletedPomKeysAdded = ((B.d.exportProject().state || {}).deletedPomKeys || []).length - delBefore;
    }

    // ---- (iii-b) not offered for a line hidden by the review x Hide toggle ----
    await B.restore();
    B.clearSelection();
    await B.settle();
    base = curves()[0];
    B.click(base.start);
    const hidden = { offeredVisible: !document.getElementById('toolAddPoint').hidden };
    // Press the panel's OWN x toggle, not d.setHiddenAnnIds. US-093 / ADR 0053
    // code review, 2026-08-21: toggleAnnHidden (spec-visibility.js) now ends in
    // updateUI() rather than renderSpecPanel(), so hiding the selected line
    // withdraws the Add point button in the same turn — and the debug hook,
    // which still only re-renders the panel, can no longer stand in for the
    // button. Round 1 logged attrRightAfterToggle as an un-asserted gap; the
    // gesture closes it, so it is asserted below.
    const visBtn = () => document.querySelector('tr[data-ann-id="' + base.id + '"] .pom-vis-btn');
    hidden.hasRowToggle = !!visBtn();
    if (visBtn()) visBtn().click();
    // The row is rebuilt by the toggle, so re-query: aria-pressed is the panel
    // saying the line really is hidden now, which is what the assertions about
    // the toolbar and the tool entry are conditioned on.
    hidden.rowSaysHidden = visBtn() ? visBtn().getAttribute('aria-pressed') === 'true' : null;
    hidden.attrRightAfterToggle = !!document.getElementById('toolAddPoint').hidden;
    document.getElementById('toolAddPoint').click();
    hidden.toolAfterClick = B.d.getState().tool;
    hidden.attrAfterClick = !!document.getElementById('toolAddPoint').hidden;
    hidden.anchors = anchorsOf(base.id);
    // No reset needed: loadProject clears state.hiddenAnnIds (project-load.js),
    // and the restore below is a loadProject.

    await B.restore();
    return { skipped: false, seq: base.seq, miss: miss, tooClose: tooClose, multi: multi, hidden: hidden };
  })()`);
  if (refusals.skipped) {
    console.log('board-interaction-check: no curved line on this board, Add-point refusal checks skipped');
  } else {
    console.log('board-interaction-check: refusals ' + JSON.stringify(refusals));
    const miss = refusals.miss;
    // Positive controls first: the tool has to be armed and the seed insertion
    // has to have landed, or every "nothing changed" below is vacuously true.
    check(miss.tool === 'add-point', `the Add point tool did not arm (tool ${miss.tool}) — the refusal checks test nothing`);
    check(miss.seeded === 1, `the seed insertion did not land (${miss.seeded} anchors) — the history probe below has nothing to undo`);
    check(miss.offPathPx > miss.tolerancePx,
      `the "miss" click landed ${miss.offPathPx} screen px from the curve, inside the ${miss.tolerancePx}px accept tolerance — `
      + `it is not a miss, so the refusal it triggers proves nothing`);
    check(miss.toast === 'Click on the curve to add a point.',
      `a click ${miss.offPathPx}px off the curve must say so; the toast read ${JSON.stringify(miss.toast)}. A silent no-op `
      + `reads as a broken button — and without the tolerance gate the anchor would have been inserted anyway, `
      + `${miss.offPathPx}px from where the TD clicked`);
    check(miss.anchors === miss.seeded && miss.anns === miss.annsBefore,
      `the refused click changed the board: ${miss.anchors} anchors (was ${miss.seeded}) and ${miss.anns} lines (was ${miss.annsBefore})`);
    check(miss.toolAfter === 'add-point',
      `a refused click must leave the tool armed for the next try, got ${miss.toolAfter}`);
    check(miss.oneUndoReachedBase,
      `after the refused click ONE undo left ${miss.anchorsAfterUndo} anchors instead of 0 — the refusal pushed a history `
      + `entry of its own, so the TD's undo now walks back through a step that did nothing`);
    for (const row of refusals.tooClose) {
      check(!row.seedFailed, `the "${row.label}" case could not seed its anchor — it must not skip silently`);
      check(!row.aimFailed,
        `the "${row.label}" case found no landing spot to aim at on this curve. For the accepted control that means the `
        + `${row.minSeparationPx}px gate now refuses the WHOLE curve, which is the inert button it was retuned to avoid`);
      check(row.tool === 'add-point' && row.offered,
        `the "${row.label}" case never armed the Add point tool (offered ${row.offered}, tool ${row.tool})`);
      check(row.offPathPx <= row.tolerancePx,
        `the "${row.label}" click landed ${row.offPathPx} screen px off the path, outside the ${row.tolerancePx}px accept `
        + `tolerance — it would be refused as a MISS whatever the separation gate did, so this row tests the wrong gate`);
      if (row.expectAccept) {
        // The half that stops (ii) from passing on a dead button. Round 1's own
        // note records that the first version of this gate was wide enough to
        // refuse every point of a short curve, leaving Add point visible and
        // inert; a refusal-only test would have called that a pass.
        //
        // US-093 / ADR 0053 code review, 2026-08-21: this row is aimed at the
        // nearest spot to the end that clears BOTH halves of the gate. It used
        // to be aimed 1.6x the gate's own value from the endpoint, which reads
        // as "just past it" but is not: the binding half is the handle span,
        // about a third of that clearance near an end, so the spot was inside
        // the gate and the row failed. Both halves are asserted below, so the
        // aim cannot silently drift back onto the wrong quantity.
        check(row.aimTakenPx > row.minSeparationPx && row.aimHandleSpanPx > row.minSeparationPx,
          `the "${row.label}" spot is ${row.aimTakenPx} screen px from the nearest occupied point and would leave its `
          + `shortest handle ${row.aimHandleSpanPx} px long, against a ${row.minSeparationPx}px gate — it is not past the `
          + `gate at all, so accepting it would prove nothing`);
        check(row.anchors === row.anchorsBefore + 1,
          `the nearest spot that clears the ${row.minSeparationPx}px gate on both counts (${row.aimTakenPx}px from the `
          + `nearest occupied point, ${row.aimHandleSpanPx}px of handle, t=${row.aimT}) must be accepted, but the anchor `
          + `count went ${row.anchorsBefore} -> ${row.anchors}. A gate that refuses everywhere leaves the button visible `
          + `and inert, and the refusal rows above would still pass`);
        check(row.toast === '',
          `an accepted insertion must not toast a refusal; got ${JSON.stringify(row.toast)}`);
      } else {
        check(row.sepPx <= row.minSeparationPx,
          `the "${row.label}" click landed ${row.sepPx} screen px away, outside the ${row.minSeparationPx}px gate — `
          + `it is not close enough to be refused, so this row proves nothing`);
        check(row.toast === 'Too close to an existing point. Zoom in to place one here.',
          `a landing spot ${row.sepPx} screen px from ${row.label} must be refused out loud; the toast read `
          + `${JSON.stringify(row.toast)}`);
        check(row.anchors === row.anchorsBefore && row.anns === row.annsBefore,
          `the refused click near ${row.label} changed the board: ${row.anchors} anchors (was ${row.anchorsBefore}) and `
          + `${row.anns} lines (was ${row.annsBefore}). Without the gate the split would land at t clamped to 1e-3, `
          + `collapsing the flanking bend handle onto the endpoint`);
      }
    }
    const multi = refusals.multi;
    check(multi.hasSecondCurve,
      'this board has only one curved line, so the multi-selection case cannot be built with a curved PRIMARY — without '
      + 'that it would be testing the type check, not the group check');
    check(multi.offeredSingle,
      'the Add point button was not offered for the single curved selection this case starts from, so its disappearance '
      + 'below would prove nothing');
    check(multi.clearPx > 12,
      `the second line's press point is only ${multi.clearPx}px from another line or label — too close to be sure which `
      + `line the Shift+click added`);
    check(multi.primaryId === multi.secondId,
      `the Shift+click was meant to make the second curved line the primary selection but left ${multi.primaryId} — `
      + `re-aim it, or this case is not testing a curved-primary group`);
    check(multi.offeredGroup === false,
      'the Add point button must not be offered while more than one line is selected: the Backspace that undoes an '
      + 'insertion would fall through to the GROUP delete');
    check(multi.toolAfterClick === 'select',
      `pressing the withheld button anyway left the tool at ${multi.toolAfterClick} — hiding a button is presentation, `
      + `the predicate has to refuse the tool itself`);
    check(multi.anchors === 0 && multi.anns === multi.annsBefore,
      `pressing the withheld button changed the board: ${multi.anchors} anchors on the curve and ${multi.anns} lines `
      + `(was ${multi.annsBefore})`);
    // And the damage it was withheld to prevent, measured rather than quoted.
    check(multi.linesDeleted === 2 && multi.deletedPomKeysAdded === 2,
      `Backspace on a 2-line selection deleted ${multi.linesDeleted} lines and filed ${multi.deletedPomKeysAdded} POM keys `
      + `as deleted. This is the fall-through the predicate exists to keep an anchor insert away from: if it is no longer `
      + `2 and 2, either deleteSelected changed or the Shift+click did not build a group, and the reason for the guard `
      + `above needs restating.`);
    const hid = refusals.hidden;
    check(hid.offeredVisible,
      'the Add point button was not offered for the visible curve this case starts from, so its refusal after hiding '
      + 'would prove nothing');
    check(hid.hasRowToggle && hid.rowSaysHidden === true,
      `the panel row for the selected curve did not report itself hidden after its x toggle was pressed `
      + `(toggle found: ${hid.hasRowToggle}, aria-pressed: ${hid.rowSaysHidden}) — nothing below is about a hidden line`);
    check(hid.attrRightAfterToggle === true,
      'the Add point button must be withdrawn the instant the selected line is hidden, in the same turn as the x toggle. '
      + 'A button left on screen for a line every click now refuses is the gap round 1 could only log');
    check(hid.toolAfterClick === 'select',
      `pressing Add point for a line hidden by the review x Hide toggle left the tool at ${hid.toolAfterClick} — an `
      + `insertion into a line the canvas draws nothing for would push a history entry with no visible change`);
    check(hid.attrAfterClick === true,
      'the Add point button must stay withdrawn after the withheld press');
    check(hid.anchors === 0, `the hidden line grew ${hid.anchors} anchors`);
    console.log(`board-interaction-check: Add point declines all three ways — a miss ${miss.offPathPx}px off the path, a `
      + `landing spot inside the ${refusals.tooClose[0].minSeparationPx}px separation gate (and accepts one just past it), `
      + `and is withheld from a 2-line selection (whose Backspace deletes ${multi.linesDeleted} lines) and from a hidden line`
      + ` — withdrawn in the same turn as the x toggle`);
  }

  // ---- 4i. US-093 / ADR 0053: an interior anchor on an UNSELECTED line ----
  // Round-3 code-review finding, 2026-08-21: hitTestAnyEndpoint — the test that
  // makes any visible line's end grabbable on the FIRST press (section 1) — was
  // never made anchor-aware. Nothing keeps an anchor away from an end either:
  // the Add-point separation gate is 4 screen px, and a TD can simply DRAG an
  // existing anchor there, which no insertion gate can cover. Section 4f case
  // (c) builds that geometry, but there the curve is SELECTED, so
  // hitTestSelectedHandles answers and this test never runs. Unselected, a press
  // on that anchor returned { part: 'start' } and startHandleDrag moved the
  // POM's landmark pin — restating its measured length — while the anchor the TD
  // aimed at stayed put.
  //
  // The fix makes an endpoint defer to a STRICTLY closer anchor on ANY
  // non-hidden line. Deferring is not "grab the anchor instead": interior
  // anchors are painted only for the selected line, so the anchor is invisible
  // here and the press falls through to the line BODY, which selects the line —
  // the anchor is then grabbable on the next press. Both halves are asserted.
  //
  // The counterfactual is measured through the product rather than modelled: the
  // anchor is deleted and the SAME pixel pressed again, which still opens a
  // handle drag on that end and moves it. That is what proves the pixel is
  // inside the endpoint's catch radius — so the pre-fix rule really did answer
  // 'start' here — and it prices the damage in the same units the TD reads.
  const anchorNearEnd = await s.eval(`(async () => {
    const B = window.__BI;
    const zoom = () => B.d.getView().zoom;
    const byId = (id) => B.d.getAnnotations().find(x => x.id === id);
    const curves = () => B.d.getAnnotations().filter(x => x.type === 'curved' && x.control1 && x.control2);
    const polyOf = (a) => (a.type === 'curved' && a.control1 && a.control2)
      ? B.pathPoints(a, 24) : [a.start, a.end];
    const px = (p, q) => +(Math.hypot(p.x - q.x, p.y - q.y) * zoom()).toFixed(2);
    // The measured value as the TD reads it, out of the panel row itself.
    // pointer-events.js refreshes that cell live during a handle drag, so it is
    // exactly the readout a moved landmark pin changes under the TD's eyes.
    const measured = (id) => {
      const el = document.querySelector('tr[data-ann-id="' + id + '"] .spec-measured');
      return el ? String(el.textContent || '').trim() : '';
    };
    const num = (t) => { const m = /-?[0-9]+(?:[.][0-9]+)?/.exec(t || ''); return m ? Number(m[0]) : null; };

    await B.restore();
    B.clearSelection();
    await B.settle();
    // Pick the (curve, end) with the most room around it. The press lands a few
    // px from that end, so another line's endpoint within 10px or body within
    // 8px of it would take the press for itself and the case would be measuring
    // a neighbour. Own label included — hitTestAnnotations checks label bounds
    // before the body, and a press it read as 'label' would prove nothing.
    let pick = null;
    for (const a of curves()) {
      for (const which of ['start', 'end']) {
        const p = a[which];
        let clear = Infinity;
        for (const o of B.d.getAnnotations()) {
          clear = Math.min(clear, Math.hypot(p.x - o.label.x, p.y - o.label.y));
          if (o.id === a.id) continue;
          clear = Math.min(clear, B.pathDist(p, polyOf(o)),
            Math.hypot(p.x - o.start.x, p.y - o.start.y),
            Math.hypot(p.x - o.end.x, p.y - o.end.y));
        }
        if (!pick || clear > pick.clear) pick = { id: a.id, seq: a.seq, which: which, clear: clear };
      }
    }
    if (!pick) return { skipped: true };
    const out = { skipped: false, id: pick.id, seq: pick.seq, which: pick.which,
      clearPx: +(pick.clear * zoom()).toFixed(1) };

    // Grow one anchor mid-curve, then DRAG it to 7 screen px off the chosen end,
    // perpendicular to that end's own bend handle so it does not land on the
    // handle's line. 7px is inside hitTestAnyEndpoint's radius (proved by the
    // counterfactual at the bottom) and well outside what Add point would allow.
    let ann = byId(pick.id);
    B.click(ann[pick.which]);
    out.selectedForSetup = B.d.getState().selection.id === pick.id;
    out.offered = !document.getElementById('toolAddPoint').hidden;
    document.getElementById('toolAddPoint').click();
    B.click(B.onGeom(ann, 0.5));
    document.getElementById('toolSelect').click();
    ann = byId(pick.id);
    out.grew = Array.isArray(ann.points) ? ann.points.length : -1;
    if (out.grew !== 1) return out;
    const along = pick.which === 'start'
      ? { x: ann.control1.x - ann.start.x, y: ann.control1.y - ann.start.y }
      : { x: ann.control2.x - ann.end.x, y: ann.control2.y - ann.end.y };
    const alongLen = Math.hypot(along.x, along.y) || 1;
    const g = 7 / zoom();
    const endWas = ann[pick.which];
    out.grabbed = B.dragHandleTo(ann.points[0].point, {
      x: endWas.x - (along.y / alongLen) * g,
      y: endWas.y + (along.x / alongLen) * g,
    });
    ann = byId(pick.id);
    const anchorPt = { x: ann.points[0].point.x, y: ann.points[0].point.y };
    const endPt = { x: ann[pick.which].x, y: ann[pick.which].y };
    out.gapPx = px(anchorPt, endPt);

    // ---- the press: on the anchor, line NOT selected ----
    B.clearSelection();
    await B.settle();
    const s0 = B.w2s(anchorPt);
    const screen = { x: Math.round(s0.x), y: Math.round(s0.y) };
    const exact = B.s2w(screen.x, screen.y);
    out.toAnchorPx = px(exact, anchorPt);
    out.toEndPx = px(exact, endPt);
    // Every candidate hitTestSelectedHandles would rank at this pixel, so a
    // press that opens the wrong one reports the geometry that decided it
    // instead of leaving the reader to guess.
    out.scored = B.scoreHandles(ann, exact).filter(t => t.px <= t.r + 6);
    out.inRange = B.scoreHandles(ann, exact).filter(t => t.px <= t.r).map(t => t.part).sort().join(', ');
    out.anchorHandlesPx = { in: px(ann.points[0].handleIn, anchorPt), out: px(ann.points[0].handleOut, anchorPt) };
    const before = B.snapshot();
    out.valueBefore = measured(pick.id);
    out.first = B.pressPart(screen);
    out.selection = B.d.getState().selection;
    const m = B.diff(before, B.snapshot());
    out.moved = { start: m.start, end: m.end, both: m.both, label: m.label, image: m.imageMoved };
    out.movedCount = m.start.length + m.end.length + m.both.length + m.label.length + (m.imageMoved ? 1 : 0);
    out.valueAfter = measured(pick.id);
    // ---- and the second press, with the line now selected ----
    // Two presses means two GESTURES, so let the board settle in between and
    // re-aim. Selecting the line makes the toolbar offer Add point, which
    // reflows the chrome and moves the canvas box; the pan that keeps the board
    // still on screen lands on the next frame (US-088, measured in section 0).
    // Pressing again in the same synchronous turn maps the pixel through the new
    // rect and the old pan — 35.5 screen px out on this fixture, which is
    // exactly far enough to land on the anchor's own bend handle. Both numbers
    // are recorded: the drift, and how far the re-aimed pixel had to move.
    out.driftBeforeSettlePx = px(B.s2w(screen.x, screen.y), anchorPt);
    await B.settle();
    const s1 = B.w2s(anchorPt);
    const screen2 = { x: Math.round(s1.x), y: Math.round(s1.y) };
    out.repointPx = +Math.hypot(screen2.x - screen.x, screen2.y - screen.y).toFixed(2);
    out.toAnchorPx2 = px(B.s2w(screen2.x, screen2.y), anchorPt);
    out.second = B.pressPart(screen2);

    // ---- counterfactual: the same pixel, no anchor to defer to ----
    // The second press left selection.part on the anchor, so Backspace is the
    // anchor-delete branch (4c asserts that pairing).
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    const stripped = byId(pick.id);
    out.lineSurvivedDelete = !!stripped;
    out.anchorsAfterDelete = stripped && Array.isArray(stripped.points) ? stripped.points.length : -1;
    if (out.anchorsAfterDelete !== 0) return out;
    B.clearSelection();
    await B.settle();
    // Deselecting puts the chrome back where it was when the pixel was computed,
    // so this really is the same pixel over the same world point — recorded, not
    // assumed, because the whole counterfactual rests on it.
    out.cfToAnchorPx = px(B.s2w(screen.x, screen.y), anchorPt);
    const cfBefore = B.snapshot();
    out.cfValueBefore = measured(pick.id);
    B.ev('mousedown', screen.x, screen.y);
    out.cfOpened = (() => { const it = B.d.getInteraction();
      return it ? { type: it.type, part: it.part, id: it.id } : null; })();
    for (let i = 1; i <= 6; i += 1) B.ev('mousemove', screen.x + 18 * i / 6, screen.y + 14 * i / 6);
    B.ev('mouseup', screen.x + 18, screen.y + 14);
    await B.settle();
    const cfAnn = byId(pick.id);
    out.cfEndMovedPx = px({ x: cfAnn[pick.which].x, y: cfAnn[pick.which].y }, endPt);
    const cfDiff = B.diff(cfBefore, B.snapshot());
    out.cfMoved = { start: cfDiff.start, end: cfDiff.end, both: cfDiff.both };
    out.cfValueAfter = measured(pick.id);
    out.cfValueDelta = (num(out.cfValueAfter) != null && num(out.cfValueBefore) != null)
      ? +(num(out.cfValueAfter) - num(out.cfValueBefore)).toFixed(3) : null;
    await B.restore();
    return out;
  })()`);
  if (anchorNearEnd.skipped) {
    console.log('board-interaction-check: no curved line on this board, unselected-anchor check skipped');
  } else {
    console.log('board-interaction-check: unselected anchor ' + JSON.stringify(anchorNearEnd));
    const a = anchorNearEnd;
    const label = `POM ${a.seq}.${a.which}`;
    // Positive controls: the scenario has to exist before "the endpoint deferred"
    // means anything. Each one is a way the case could quietly test nothing.
    check(a.clearPx > 20,
      `${label} is the roomiest curve end on this board and it is still only ${a.clearPx} screen px from another line, `
      + `its endpoint or a label — a press beside it could be claimed by that neighbour instead, so this case cannot be `
      + `built here any more`);
    check(a.selectedForSetup && a.offered,
      `${label}: the setup press did not select the curve (selected ${a.selectedForSetup}, Add point offered ${a.offered})`);
    check(a.grew === 1, `${label}: the setup insertion left ${a.grew} interior anchors, not 1`);
    check(a.grabbed && a.grabbed.type === 'drag-handle' && a.grabbed.part === 'point0.point',
      `${label}: the setup drag opened ${JSON.stringify(a.grabbed)} instead of a drag of the anchor itself, so the anchor `
      + `is not where this case needs it`);
    check(a.toAnchorPx < 1 && a.gapPx > 0,
      `${label}: the press landed ${a.toAnchorPx} screen px from the anchor (anchor ${a.gapPx}px from the end) — it has to `
      + `be ON the anchor for the deferral to be what is under test`);
    // The competing set, as an exact set rather than a count (section 1's rule).
    // Exactly two things are in range at this pixel: the anchor the TD aimed at
    // and the endpoint that used to take it. A third would mean the fixture has
    // drifted and the press is no longer about the deferral.
    check(a.inRange === ['point0.point', a.which].sort().join(', '),
      `${label}: the candidates in range at that pixel are [${a.inRange}], not just the anchor and '${a.which}'. `
      + `Distances: ${JSON.stringify(a.scored)}, and the anchor's own handles sit ${JSON.stringify(a.anchorHandlesPx)} away`);
    // The behaviour itself.
    check(!!a.first && a.first.type === 'drag-annotation' && a.first.id === a.id,
      `${label}: pressing the invisible anchor of an UNSELECTED curve opened ${JSON.stringify(a.first)}. It must fall `
      + `through to the line body: a 'drag-handle' on '${a.which}' here is the landmark pin, ${a.toEndPx}px away, moving `
      + `instead of the anchor the TD aimed at`);
    check(!!a.first && a.first.part === null,
      `${label}: the press opened part ${JSON.stringify(a.first && a.first.part)} — a label drag or a handle drag, not the `
      + `line-body fall-through the deferral exists to reach`);
    check(!!a.selection && a.selection.kind === 'annotation' && a.selection.id === a.id,
      `${label}: the press must leave THIS line selected so the next press can reach the anchor; selection is `
      + `${JSON.stringify(a.selection)}`);
    check(a.movedCount === 0,
      `${label}: the press moved something — ${JSON.stringify(a.moved)}. A press with no travel is a click (section 4), so `
      + `nothing on the board may shift`);
    check(a.valueAfter === a.valueBefore,
      `${label}: the measured value read ${JSON.stringify(a.valueBefore)} before the press and `
      + `${JSON.stringify(a.valueAfter)} after`);
    check(a.toAnchorPx2 < 1,
      `${label}: the re-aimed second press lands ${a.toAnchorPx2} screen px from the anchor (the pixel moved `
      + `${a.repointPx}px after the chrome settled) — it has to be ON the anchor to say anything about the second press`);
    check(!!a.second && a.second.type === 'drag-handle' && a.second.part === 'point0.point',
      `${label}: the SECOND press must grab the anchor now that the line is selected, got ${JSON.stringify(a.second)}. `
      + `Deferring is only acceptable because the anchor is one press away`);
    // The counterfactual, which is also the proof the assertions above can fail.
    check(a.lineSurvivedDelete && a.anchorsAfterDelete === 0,
      `${label}: Backspace after the second press left ${a.anchorsAfterDelete} anchors (line survived: `
      + `${a.lineSurvivedDelete}) — the counterfactual below needs the anchor gone and the line intact`);
    check(a.cfToAnchorPx < 1,
      `${label}: with the anchor deleted the counterfactual pixel maps ${a.cfToAnchorPx} screen px from where the anchor `
      + `was, so it is no longer the SAME press and it proves nothing about the one above`);
    check(!!a.cfOpened && a.cfOpened.type === 'drag-handle' && a.cfOpened.part === a.which
      && a.cfOpened.id === a.id,
      `${label}: with the anchor deleted, the SAME pixel opened ${JSON.stringify(a.cfOpened)} instead of a handle drag on `
      + `'${a.which}'. That press is the only evidence the pixel is inside hitTestAnyEndpoint's radius — without it the `
      + `deferral assertions above could be passing on a press the endpoint never wanted`);
    check(a.cfEndMovedPx > 5,
      `${label}: the counterfactual drag moved the endpoint ${a.cfEndMovedPx} screen px — too little to price the defect`);
    check(a.cfValueDelta !== null && Math.abs(a.cfValueDelta) > 0,
      `${label}: the counterfactual endpoint drag left the measured value at ${JSON.stringify(a.cfValueAfter)} — if moving `
      + `this landmark does not restate the measurement, the panel readout is not sensitive enough to prove what the `
      + `deferral prevents`);
    console.log(`board-interaction-check: ${label} — an anchor ${a.gapPx}px from the end takes the press away from it `
      + `(falls through to the line body, nothing moved, value ${a.valueBefore} held; anchor grabbable on the next press). `
      + `Same pixel with the anchor deleted: drag-handle '${a.cfOpened && a.cfOpened.part}', landmark moved `
      + `${a.cfEndMovedPx}px and the value went ${a.cfValueBefore} -> ${a.cfValueAfter} `
      + `(${a.cfValueDelta > 0 ? '+' : ''}${a.cfValueDelta})`);
  }

  // ---- 4j. US-093 / ADR 0053: the deferral crosses the LINE boundary ----
  // Round-4 code-review finding, 2026-08-21: round 3's deferral (section 4i) was
  // scoped PER ANNOTATION — the anchor scan sat inside the endpoint loop, so
  // line B's turn round the loop saw only B's own (empty) points. A press 1px
  // from line A's anchor that was also inside hitTestAnyEndpoint's radius of line
  // B's END still returned { id: B, part } and startHandleDrag moved B's landmark
  // pin, restating B's measured length, while the TD was aiming at A's anchor.
  // Round 4 hoisted the scan out of the endpoint loop into one pass over every
  // non-hidden line, so an endpoint now yields to a strictly closer anchor
  // wherever on the board that anchor lives.
  //
  // Section 4i structurally cannot reach this. It picks the (curve, end) with the
  // MAXIMUM clearance from every other line's endpoints, body and label, so no
  // FOREIGN endpoint is ever in range there and hoisting the scan cannot change
  // its outcome. This section goes looking for the opposite geometry on purpose.
  // Round 4's fix was verified only by an out-of-repo fuzz harness (30,000
  // synthetic boards); this is the first thing in the repo that presses the pixel.
  //
  // Two facts are what make the case about the HOIST rather than about round 3
  // again, and both are asserted rather than assumed:
  //   * the only interior anchor anywhere on the board belongs to line A, so
  //     line B has no points of its own and a per-annotation scan would have
  //     deferred nothing at all;
  //   * line A's own two ends are OUTSIDE hitTestAnyEndpoint's radius at the
  //     press, so the deferral cannot be the same-line one 4i already covers.
  //
  // The geometry is real, not contrived: this template's POMs deliberately share
  // endpoints (section 1's EXPECTED_COINCIDENT names six grabs that land on a
  // sibling), so foreign endpoints sit within a few px of each other all over
  // this board. Those are straight lines and cannot grow anchors, so the case is
  // built the way a TD would reach it — grow one anchor mid-curve, then DRAG it
  // beside a different POM's endpoint, which is the gesture no insertion gate
  // covers (section 4f case (c) uses the same route for the selected line).
  //
  // The counterfactual is 4i's, for the same reason: the anchor is the only thing
  // the round-4 predicate adds, so the SAME pixel is pressed again with the
  // anchor deleted. That press must open a handle drag on the FOREIGN end and
  // move it — the pre-hoist answer, priced in the units the TD reads off the
  // panel. If it ever stops differing, the assertions above have stopped
  // exercising the cross-line path and this section says so instead of passing.
  const crossLine = await s.eval(`(async () => {
    const B = window.__BI;
    const gate = window.__BI_GATE;
    const zoom = () => B.d.getView().zoom;
    const byId = (id) => B.d.getAnnotations().find(x => x.id === id);
    const isCurve = (a) => a.type === 'curved' && !!a.control1 && !!a.control2;
    const polyOf = (a) => isCurve(a) ? B.pathPoints(a, 24) : [a.start, a.end];
    const px = (p, q) => +(Math.hypot(p.x - q.x, p.y - q.y) * zoom()).toFixed(2);
    // The measured value as the TD reads it, out of the panel row itself — the
    // readout a moved landmark pin restates under the TD's eyes (4i's helper).
    const measured = (id) => {
      const el = document.querySelector('tr[data-ann-id="' + id + '"] .spec-measured');
      return el ? String(el.textContent || '').trim() : '';
    };
    const num = (t) => { const m = /-?[0-9]+(?:[.][0-9]+)?/.exec(t || ''); return m ? Number(m[0]) : null; };
    const totalAnchors = () => B.d.getAnnotations()
      .reduce((n, a) => n + (Array.isArray(a.points) ? a.points.length : 0), 0);
    const endsOf = (a) => [{ part: 'start', p: a.start }, { part: 'end', p: a.end }].filter(e => !!e.p);

    await B.restore();
    B.clearSelection();
    await B.settle();
    const anns = B.d.getAnnotations();
    if (!anns.some(isCurve)) return { skipped: true };
    const z = zoom();
    const dpx = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) * z;
    const polys = anns.map(polyOf);
    const rect = document.getElementById('boardCanvas').getBoundingClientRect();
    // The gap to leave between the anchor and the foreign endpoint. 7 screen px
    // is 4i's figure: comfortably inside hitTestAnyEndpoint's reach with room for
    // the integer-pixel rounding of the press (up to 0.71px) at either end, and
    // far outside anything Add point would accept.
    const GAP_PX = 7;
    // pointInLabelBounds builds a box about 30 x 30 screen px (17px font, 8px
    // padding), so 25px from its CENTRE clears it without modelling the box here.
    const LABEL_CLEAR_PX = 25;

    // The direction the line leaves the end by, so the anchor can be pushed
    // PERPENDICULAR to it: straight off the end, the projection onto the line
    // lands on the endpoint itself, which is what keeps the offset honest.
    const outward = (a, which) => {
      const p = a[which];
      const q = which === 'start' ? (a.control1 || a.end) : (a.control2 || a.start);
      const t = { x: q.x - p.x, y: q.y - p.y };
      const len = Math.hypot(t.x, t.y);
      return len > 1e-9 ? { x: t.x / len, y: t.y / len } : { x: 1, y: 0 };
    };

    // Search every (curve, foreign end, side) the board offers rather than
    // naming a pair: which POMs end up beside each other is a property of the
    // detection, and a hard-coded pair would silently stop being adjacent.
    const rejects = {};
    const rej = (k) => { rejects[k] = (rejects[k] || 0) + 1; };
    const candidates = [];
    for (let ia = 0; ia < anns.length; ia += 1) {
      const A = anns[ia];
      if (!isCurve(A)) continue;
      // The foreign line must sit BELOW A in draw order. hitTestAnnotations
      // scans topmost-first and returns the FIRST line whose label box or body
      // contains the press, not the nearest, so only lines drawn after A can
      // outrank it — and the press has to fall through to A's body for the
      // positive outcome to be A being selected.
      for (let ib = 0; ib < ia; ib += 1) {
        const F = anns[ib];
        for (const e of endsOf(F)) {
          const dir = outward(F, e.part);
          for (const side of [1, -1]) {
            const P = { x: e.p.x - dir.y * side * (GAP_PX / z), y: e.p.y + dir.x * side * (GAP_PX / z) };
            // On the visible board, so the gesture is one a TD could make.
            const sp = B.w2s(P);
            if (sp.x < rect.left + 40 || sp.x > rect.right - 40
              || sp.y < rect.top + 40 || sp.y > rect.bottom - 40) { rej('offBoard'); continue; }
            // A's own ends out of reach, or this is 4i's same-line deferral again.
            const ownEndsPx = Math.min(dpx(P, A.start), dpx(P, A.end));
            if (ownEndsPx <= gate.anyEndpointRadiusPx + 4) { rej('ownEndInReach'); continue; }
            // Every endpoint in reach of the press, and every one of them has to
            // belong to some OTHER line — that is the whole subject here.
            const inReach = [];
            let ownInReach = false;
            for (const C of anns) {
              for (const c of endsOf(C)) {
                const d = dpx(P, c.p);
                if (d > gate.anyEndpointRadiusPx) continue;
                if (C.id === A.id) ownInReach = true;
                inReach.push({ pom: 'POM' + C.seq + '.' + c.part, id: C.id, part: c.part, px: +d.toFixed(2) });
              }
            }
            if (ownInReach || !inReach.length) { rej('endpointSet'); continue; }
            // Nothing drawn ABOVE A may claim the press for its own body or its
            // own label box.
            let aboveBodyPx = Infinity, aboveLabelPx = Infinity;
            for (let ic = ia + 1; ic < anns.length; ic += 1) {
              aboveBodyPx = Math.min(aboveBodyPx, B.pathDist(P, polys[ic]) * z);
              aboveLabelPx = Math.min(aboveLabelPx, dpx(P, anns[ic].label));
            }
            if (aboveBodyPx <= gate.bodyTolerancePx + 4) { rej('aboveBody'); continue; }
            if (aboveLabelPx <= LABEL_CLEAR_PX) { rej('aboveLabel'); continue; }
            candidates.push({
              idA: A.id, seqA: A.seq, idF: F.id, seqF: F.seq, which: e.part, P: P,
              inReach: inReach, ownEndsPx: +ownEndsPx.toFixed(2),
              aboveBodyPx: +aboveBodyPx.toFixed(2), aboveLabelPx: +aboveLabelPx.toFixed(2),
              travelPx: +dpx(B.onGeom(A, 0.5), P).toFixed(1),
              clear: Math.min(ownEndsPx - gate.anyEndpointRadiusPx,
                aboveBodyPx - gate.bodyTolerancePx, aboveLabelPx - LABEL_CLEAR_PX),
            });
          }
        }
      }
    }
    // Widest margin first, shortest anchor travel to break a tie: the roomiest
    // press is the one whose outcome is least likely to be decided by something
    // this section is not testing.
    candidates.sort((x, y) => (y.clear - x.clear) || (x.travelPx - y.travelPx));
    const out = { skipped: false, nCandidates: candidates.length, rejects: rejects,
      top: candidates.slice(0, 4).map(c => ({ curve: 'POM' + c.seqA, foreign: 'POM' + c.seqF + '.' + c.which,
        clearPx: +c.clear.toFixed(1), travelPx: c.travelPx, inReach: c.inReach.map(r => r.pom).join(' ') })) };
    if (!candidates.length) return out;
    // A note box is hit-tested BEFORE the line body, so one sitting on the press
    // would take the fall-through and the positive outcome below would be wrong
    // about why. This board carries none; recorded so it cannot change quietly.
    out.notes = (B.d.getNotes() || []).length;

    // Where line A can be selected by its own BODY: the point of its path with
    // the most clearance from every other line and label. Not an endpoint, the
    // way 4c and 4i select: several of this template's ends are shared
    // (EXPECTED_COINCIDENT), so an endpoint press can select the SIBLING and the
    // setup would build itself on the wrong line.
    const bodySpot = (A) => {
      let best = null;
      for (const p of B.pathPoints(A, 24)) {
        let clear = Infinity;
        for (let i = 0; i < anns.length; i += 1) {
          if (anns[i].id === A.id) continue;
          clear = Math.min(clear, B.pathDist(p, polys[i]) * z, dpx(p, anns[i].label));
        }
        if (!best || clear > best.clear) best = { p: p, clear: clear };
      }
      return best;
    };

    // ---- build one candidate: an anchor mid-curve, dragged beside the end ----
    // Reports everything that decides whether the build is usable, and never
    // reports what the PRESS did: the press is the subject of this section, so it
    // must not be part of choosing which candidate to press.
    const build = async (cand) => {
      await B.restore();
      B.clearSelection();
      await B.settle();
      const r = { curve: 'POM' + cand.seqA, foreign: 'POM' + cand.seqF + '.' + cand.which, why: null };
      let ann = byId(cand.idA);
      const spot = bodySpot(ann);
      r.setupClearPx = +spot.clear.toFixed(1);
      B.click(spot.p);
      await B.settle();
      r.selectedForSetup = B.d.getState().selection.id === cand.idA;
      r.offered = !document.getElementById('toolAddPoint').hidden;
      if (!r.selectedForSetup || !r.offered) { r.why = 'setup-selection'; return r; }
      document.getElementById('toolAddPoint').click();
      await B.settle();
      B.click(B.onGeom(ann, 0.5));
      document.getElementById('toolSelect').click();
      await B.settle();
      ann = byId(cand.idA);
      r.grew = Array.isArray(ann.points) ? ann.points.length : -1;
      if (r.grew !== 1) { r.why = 'insertion'; return r; }
      r.grabbed = B.dragHandleTo(ann.points[0].point, cand.P);
      await B.settle();
      ann = byId(cand.idA);
      r.anchorPt = { x: ann.points[0].point.x, y: ann.points[0].point.y };
      r.foreignWas = { x: byId(cand.idF)[cand.which].x, y: byId(cand.idF)[cand.which].y };
      r.gapPx = px(r.anchorPt, r.foreignWas);
      r.anchorsBuilt = totalAnchors();
      B.clearSelection();
      await B.settle();
      const s0 = B.w2s(r.anchorPt);
      r.screen = { x: Math.round(s0.x), y: Math.round(s0.y) };
      const exact = B.s2w(r.screen.x, r.screen.y);
      r.toAnchorPx = px(exact, r.anchorPt);
      r.toForeignPx = px(exact, r.foreignWas);
      r.ownEndsPx = Math.min(px(exact, ann.start), px(exact, ann.end));
      r.ownLabelPx = px(exact, ann.label);
      r.endsInReach = [];
      for (const cc of B.d.getAnnotations()) {
        for (const e of endsOf(cc)) {
          const d = px(exact, e.p);
          if (d <= gate.anyEndpointRadiusPx) {
            r.endsInReach.push({ pom: 'POM' + cc.seq + '.' + e.part, id: cc.id, part: e.part, px: d,
              own: cc.id === cand.idA });
          }
        }
      }
      // The ONE reason a built candidate is retried rather than asserted on.
      // dragHandle ends in computeDefaultLabelPosition, so the callout is
      // recomputed on the reshaped path — and once the anchor sits near that
      // path's half-arc-length point, the callout lands about 20px from it,
      // which is inside its own label box: hitTestAnnotations tests a line's
      // label BEFORE its body, so the press would read as a label drag and never
      // reach the fall-through this section is about. Where the callout goes is a
      // property of the reshaped curve, not of the candidate, so it can only be
      // measured after the drag. Everything else stays an assertion below.
      if (r.ownLabelPx <= LABEL_CLEAR_PX) { r.why = 'callout-on-press'; return r; }
      return r;
    };

    const attempts = [];
    let use = null, pick = null;
    for (const cand of candidates.slice(0, 8)) {
      const r = await build(cand);
      attempts.push({ curve: r.curve, foreign: r.foreign, why: r.why, gapPx: r.gapPx,
        toAnchorPx: r.toAnchorPx, ownEndsPx: r.ownEndsPx, ownLabelPx: r.ownLabelPx,
        anchors: r.anchorsBuilt, grew: r.grew });
      use = r; pick = cand;
      if (r.why !== 'callout-on-press') break;
    }
    out.attempts = attempts;
    for (const k of ['setupClearPx', 'selectedForSetup', 'offered', 'grew', 'grabbed', 'gapPx',
      'anchorsBuilt', 'toAnchorPx', 'toForeignPx', 'ownEndsPx', 'ownLabelPx', 'endsInReach']) out[k] = use[k];
    out.built = use.why === null;
    out.why = use.why;
    out.seqA = pick.seqA; out.idA = pick.idA;
    out.foreign = 'POM' + pick.seqF + '.' + pick.which;
    out.idF = pick.idF; out.which = pick.which;
    out.clearPx = +pick.clear.toFixed(1);
    out.travelPx = pick.travelPx;
    if (!out.built) return out;
    const anchorPt = use.anchorPt, foreignWas = use.foreignWas, screen = use.screen;

    // ---- the press: on the anchor, NOTHING selected ----
    const watch = Array.from(new Set(out.endsInReach.map(e => e.id)));
    const before = B.snapshot();
    out.valuesBefore = watch.map(id => measured(id));
    out.first = B.pressPart(screen);
    out.selection = B.d.getState().selection;
    const m = B.diff(before, B.snapshot());
    out.moved = { start: m.start, end: m.end, both: m.both, label: m.label, image: m.imageMoved };
    out.movedCount = m.start.length + m.end.length + m.both.length + m.label.length + (m.imageMoved ? 1 : 0);
    out.valuesAfter = watch.map(id => measured(id));
    out.foreignEndMovedPx = px({ x: byId(pick.idF)[pick.which].x, y: byId(pick.idF)[pick.which].y }, foreignWas);

    // ---- the anchor is one press away, which is also how it gets deleted ----
    // Same US-088 settle-and-re-aim as 4i: the press just selected A, which grows
    // the toolbar and moves the canvas box, and the compensating pan lands on the
    // NEXT frame. Both numbers are recorded — the drift, and how far the re-aimed
    // pixel had to move once the chrome settled.
    out.driftBeforeSettlePx = px(B.s2w(screen.x, screen.y), anchorPt);
    await B.settle();
    const s1 = B.w2s(anchorPt);
    const screen2 = { x: Math.round(s1.x), y: Math.round(s1.y) };
    out.repointPx = +Math.hypot(screen2.x - screen.x, screen2.y - screen.y).toFixed(2);
    out.toAnchorPx2 = px(B.s2w(screen2.x, screen2.y), anchorPt);
    out.second = B.pressPart(screen2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    out.lineSurvivedDelete = !!byId(pick.idA);
    out.anchorsAfterDelete = totalAnchors();
    if (!out.lineSurvivedDelete || out.anchorsAfterDelete !== 0) return out;

    // ---- counterfactual: the same pixel, no anchor anywhere to defer to ----
    B.clearSelection();
    await B.settle();
    // Deselecting puts the chrome back where it was when the pixel was computed,
    // so this really is the same pixel over the same world point — recorded, not
    // assumed, because the whole counterfactual rests on it.
    out.cfToAnchorPx = px(B.s2w(screen.x, screen.y), anchorPt);
    const posBefore = {};
    for (const c of B.d.getAnnotations()) posBefore[c.id] = { start: c.start, end: c.end };
    const cfBefore = B.snapshot();
    B.ev('mousedown', screen.x, screen.y);
    out.cfOpened = (() => { const it = B.d.getInteraction();
      return it ? { type: it.type, part: it.part, id: it.id } : null; })();
    out.cfValueBefore = out.cfOpened ? measured(out.cfOpened.id) : '';
    for (let i = 1; i <= 6; i += 1) B.ev('mousemove', screen.x + 18 * i / 6, screen.y + 14 * i / 6);
    B.ev('mouseup', screen.x + 18, screen.y + 14);
    await B.settle();
    // Measure whatever the press actually grabbed, not what it was expected to:
    // several of this board's endpoints are coincident, so the nearest one at
    // this pixel is the fixture's decision to report rather than the caller's.
    out.cfGrabbedIsForeign = !!out.cfOpened && out.cfOpened.id !== pick.idA;
    out.cfGrabbedMovedPx = (out.cfOpened && posBefore[out.cfOpened.id]
      && posBefore[out.cfOpened.id][out.cfOpened.part])
      ? px(byId(out.cfOpened.id)[out.cfOpened.part], posBefore[out.cfOpened.id][out.cfOpened.part])
      : -1;
    const cfDiff = B.diff(cfBefore, B.snapshot());
    out.cfMoved = { start: cfDiff.start, end: cfDiff.end, both: cfDiff.both };
    out.cfValueAfter = out.cfOpened ? measured(out.cfOpened.id) : '';
    out.cfValueDelta = (num(out.cfValueAfter) != null && num(out.cfValueBefore) != null)
      ? +(num(out.cfValueAfter) - num(out.cfValueBefore)).toFixed(3) : null;
    await B.restore();
    return out;
  })()`);
  if (crossLine.skipped) {
    console.log('board-interaction-check: no curved line on this board, cross-line deferral check skipped');
  } else {
    console.log('board-interaction-check: cross-line deferral ' + JSON.stringify(crossLine));
    const c = crossLine;
    // Positive controls first. Every one of these is a way the case could stop
    // being about a FOREIGN endpoint and pass anyway.
    check(c.nCandidates > 0,
      `no (curve, foreign endpoint) pair on this board can be brought within ${served.radii.anyEndpointRadiusPx}px of `
      + `each other without some other line claiming the press. Rejected by gate: ${JSON.stringify(c.rejects)}. `
      + `Without a pair the cross-line half of the deferral has no coverage at all — re-aim this section, do not drop it`);
    // The one precondition that is retried instead of asserted, so this is where
    // running out of candidates shows up. `ownLabelPx` is the number to read: a
    // callout that lands on the press turns the fall-through into a label drag,
    // and it is a property of the curve AFTER the anchor is dragged, which no
    // candidate gate can see in advance.
    check(c.built === true,
      `none of the top ${(c.attempts || []).length} candidates could be built into a pressable case (last blocker: `
      + `${c.why}). Attempts: ${JSON.stringify(c.attempts)}`);
    check(c.notes === 0,
      `this board carries ${c.notes} text notes and hitTestNotes runs BEFORE the line body, so the fall-through asserted `
      + `below could be a note drag instead`);
    check(c.setupClearPx > 12,
      `the press used to select POM ${c.seqA} sits only ${c.setupClearPx} screen px from another line or label — too close `
      + `to be sure which line the setup is building on`);
    check(c.selectedForSetup === true && c.offered === true,
      `POM ${c.seqA}: the setup press did not select the curve (selected ${c.selectedForSetup}, Add point offered `
      + `${c.offered})`);
    check(c.grew === 1, `POM ${c.seqA}: the setup insertion left ${c.grew} interior anchors, not 1`);
    check(!!c.grabbed && c.grabbed.type === 'drag-handle' && c.grabbed.part === 'point0.point',
      `POM ${c.seqA}: the setup drag opened ${JSON.stringify(c.grabbed)} instead of a drag of the anchor itself, so the `
      + `anchor is not where this case needs it`);
    check(c.anchorsBuilt === 1,
      `${c.anchorsBuilt} interior anchors exist on the board, not 1. The case rests on the anchor being the ONLY thing `
      + `the round-4 predicate adds, and on the foreign line having none of its own`);
    check(c.toAnchorPx < 1 && c.gapPx > 0,
      `POM ${c.seqA}: the press landed ${c.toAnchorPx} screen px from the anchor (anchor ${c.gapPx}px from `
      + `${c.foreign}) — it has to be ON the anchor for the deferral to be what is under test`);
    check(c.toForeignPx > 0 && c.toForeignPx <= served.radii.anyEndpointRadiusPx,
      `the press sits ${c.toForeignPx} screen px from ${c.foreign}, outside hitTestAnyEndpoint's `
      + `${served.radii.anyEndpointRadiusPx}px radius — that endpoint never wanted this press, so deferring it proves nothing`);
    // The two facts that make this round 4 and not round 3 over again.
    check(c.ownEndsPx > served.radii.anyEndpointRadiusPx,
      `POM ${c.seqA}'s own nearest end is ${c.ownEndsPx} screen px from the press, inside the `
      + `${served.radii.anyEndpointRadiusPx}px radius — the case has collapsed into section 4i's same-line deferral, which `
      + `round 3 already covered`);
    check(c.endsInReach.length > 0 && c.endsInReach.every(e => e.own === false),
      `the endpoints in reach at that pixel are ${JSON.stringify(c.endsInReach)}. They must all belong to OTHER lines: a `
      + `per-annotation anchor scan sees no points on any of them, so only the hoisted scan can defer them`);
    // The behaviour, stated as the outcome the TD gets rather than as an absence.
    check(!!c.first && c.first.type === 'drag-annotation' && c.first.id === c.idA,
      `pressing POM ${c.seqA}'s invisible anchor opened ${JSON.stringify(c.first)}. It must fall through to POM `
      + `${c.seqA}'s BODY: a 'drag-handle' on ${c.foreign} here is a DIFFERENT POM's landmark pin, ${c.toForeignPx}px `
      + `away, moving instead of the anchor the TD aimed at`);
    check(!!c.first && c.first.part === null,
      `the press opened part ${JSON.stringify(c.first && c.first.part)} — a label or handle drag, not the line-body `
      + `fall-through the deferral exists to reach`);
    check(!!c.selection && c.selection.kind === 'annotation' && c.selection.id === c.idA,
      `the press must leave POM ${c.seqA} selected, so the anchor is one press away; selection is `
      + `${JSON.stringify(c.selection)}`);
    check(c.movedCount === 0,
      `the press moved something — ${JSON.stringify(c.moved)}. A press with no travel is a click (section 4), so nothing `
      + `on the board may shift`);
    check(c.foreignEndMovedPx === 0,
      `${c.foreign} moved ${c.foreignEndMovedPx} screen px on a press aimed at POM ${c.seqA}'s anchor — that is a foreign `
      + `POM's landmark pin leaving its detected position`);
    check(JSON.stringify(c.valuesAfter) === JSON.stringify(c.valuesBefore),
      `the measured values of the POMs whose ends are in reach read ${JSON.stringify(c.valuesBefore)} before the press and `
      + `${JSON.stringify(c.valuesAfter)} after — the press restated another line's measurement`);
    check(c.toAnchorPx2 < 1,
      `the re-aimed second press lands ${c.toAnchorPx2} screen px from the anchor (the pixel moved ${c.repointPx}px once `
      + `the chrome settled, drift ${c.driftBeforeSettlePx}px before it) — it has to be ON the anchor`);
    check(!!c.second && c.second.type === 'drag-handle' && c.second.part === 'point0.point',
      `the SECOND press must grab the anchor now that POM ${c.seqA} is selected, got ${JSON.stringify(c.second)}. `
      + `Deferring is only acceptable because the anchor is one press away — and this is also what makes the Backspace `
      + `below the anchor-delete branch rather than the line delete`);
    // The counterfactual, which is also the proof the assertions above can fail.
    check(c.lineSurvivedDelete === true && c.anchorsAfterDelete === 0,
      `Backspace after the second press left ${c.anchorsAfterDelete} anchors on the board (line survived: `
      + `${c.lineSurvivedDelete}) — the counterfactual needs every anchor gone and POM ${c.seqA} intact`);
    check(c.cfToAnchorPx < 1,
      `with the anchor deleted the counterfactual pixel maps ${c.cfToAnchorPx} screen px from where the anchor was, so it `
      + `is no longer the SAME press and it proves nothing about the one above`);
    check(!!c.cfOpened && c.cfOpened.type === 'drag-handle' && c.cfGrabbedIsForeign === true
      && c.endsInReach.some(e => e.id === c.cfOpened.id && e.part === c.cfOpened.part),
      `with the anchor deleted, the SAME pixel opened ${JSON.stringify(c.cfOpened)} instead of a handle drag on one of the `
      + `foreign ends in reach (${JSON.stringify(c.endsInReach)}). That press is the only evidence the cross-line path is `
      + `being exercised at all: without it the deferral assertions above could be passing because no other line's `
      + `endpoint was ever in range, which is exactly what makes section 4i blind to this`);
    check(c.cfGrabbedMovedPx > 5,
      `the counterfactual drag moved that foreign endpoint ${c.cfGrabbedMovedPx} screen px — too little to price the defect`);
    check(c.cfValueDelta !== null && Math.abs(c.cfValueDelta) > 0,
      `the counterfactual drag left the foreign POM's measured value at ${JSON.stringify(c.cfValueAfter)} — if moving a `
      + `landmark on THAT line does not restate its measurement, the panel readout is not sensitive enough to price what `
      + `the hoisted scan prevents`);
    console.log(`board-interaction-check: POM ${c.seqA}'s anchor, dragged ${c.travelPx}px to sit ${c.gapPx}px from `
      + `${c.foreign} (a DIFFERENT line, ${c.clearPx}px of margin around the press), takes the press away from it — falls `
      + `through to POM ${c.seqA}'s body, selects it, nothing moved, values ${JSON.stringify(c.valuesBefore)} held. Same `
      + `pixel with the anchor deleted: drag-handle on ${JSON.stringify(c.cfOpened)}, that landmark moved `
      + `${c.cfGrabbedMovedPx}px and its value went ${c.cfValueBefore} -> ${c.cfValueAfter} `
      + `(${c.cfValueDelta > 0 ? '+' : ''}${c.cfValueDelta})`);
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

  // ---- 7b. Resizing the sketch scales its lines and holds every value ----
  // US-091. Anchors are normalized to their image and scale for free;
  // annotations are absolute world coordinates and did not move at all, so a
  // resized sketch left all 18 POM lines detached from the garment. Scaling
  // them fixes the geometry but would restate every measurement, since a value
  // is lineLength x unitsPerPx — so each line carries the factor in
  // measureScale and lineLength divides it back out. Both halves are asserted:
  // geometry followed, and NOT ONE measured value moved.
  const resize = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    await B.settle();
    const canvas = document.getElementById('boardCanvas');
    const shot = () => B.d.getAnnotations().map(a => ({
      id: a.id,
      drawn: Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y),
      ms: (Number.isFinite(a.measureScale) && a.measureScale > 0) ? a.measureScale : 1,
      sx: a.start.x, sy: a.start.y,
    }));
    const im = B.d.getImages()[0];
    const before = shot();
    const beforeW = im.width;
    // Select the photo first (US-086 select-then-drag) — the corner handles
    // only exist once it is selected. Press at the point on the photo furthest
    // from every line, or the press is claimed by a line and the corner press
    // that follows falls through to a marquee, testing nothing.
    let spot = null, bestClear = -1;
    for (let gx = 1; gx <= 14; gx += 1) for (let gy = 1; gy <= 14; gy += 1) {
      const p = { x: im.x + im.width * gx / 15, y: im.y + im.height * gy / 15 };
      let clear = Infinity;
      for (const a of B.d.getAnnotations()) {
        const vx = a.end.x - a.start.x, vy = a.end.y - a.start.y;
        const len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.start.x) * vx + (p.y - a.start.y) * vy) / len2));
        clear = Math.min(clear, Math.hypot(p.x - (a.start.x + vx * t), p.y - (a.start.y + vy * t)));
      }
      if (clear > bestClear) { bestClear = clear; spot = p; }
    }
    const mid = B.w2s(spot);
    B.ev('mousedown', mid.x, mid.y); B.ev('mouseup', mid.x, mid.y);
    await B.settle();
    const se = B.w2s({ x: im.x + im.width, y: im.y + im.height });
    B.ev('mousedown', se.x, se.y);
    const opened = (B.d.getInteraction() || {}).type;
    for (let i = 1; i <= 6; i += 1) B.ev('mousemove', se.x + 120 * i / 6, se.y + 90 * i / 6);
    B.ev('mouseup', se.x + 120, se.y + 90);
    await B.settle();
    const after = shot();
    const imgScale = B.d.getImages()[0].width / beforeW;
    const byId = new Map(before.map(l => [l.id, l]));
    let movedCount = 0, worstValueDrift = 0, worstScaleErr = 0;
    for (const l of after) {
      const b = byId.get(l.id); if (!b) continue;
      if (Math.hypot(l.sx - b.sx, l.sy - b.sy) > 0.5) movedCount += 1;
      const beforeValue = b.drawn / b.ms, afterValue = l.drawn / l.ms;
      worstValueDrift = Math.max(worstValueDrift, Math.abs(afterValue - beforeValue) / (beforeValue || 1));
      worstScaleErr = Math.max(worstScaleErr, Math.abs(l.ms / b.ms - imgScale));
    }
    await B.restore();
    return { opened, imgScale: +imgScale.toFixed(4), n: after.length, movedCount,
      worstValueDriftPct: +(worstValueDrift * 100).toFixed(4),
      worstScaleErr: +worstScaleErr.toFixed(6) };
  })()`);
  console.log('board-interaction-check: resize ' + JSON.stringify(resize));
  check(resize.opened === 'drag-image-resize',
    `the corner press opened ${resize.opened} instead of a resize — nothing was tested`);
  check(resize.imgScale > 1.05, `the photo barely resized (x${resize.imgScale}) — nothing was tested`);
  check(resize.movedCount === resize.n,
    `the photo scaled x${resize.imgScale} but only ${resize.movedCount}/${resize.n} lines followed it`);
  check(resize.worstScaleErr < 0.001,
    `a line recorded measureScale off the photo's own scale by ${resize.worstScaleErr}`);
  check(resize.worstValueDriftPct < 0.01,
    `resizing the sketch moved a measured value by ${resize.worstValueDriftPct}% — a layout act must not restate a measurement`);
  console.log(`board-interaction-check: resize x${resize.imgScale} scales all ${resize.n} lines and changes no measured value`);

  // ---- 7c. Text notes ride with the sketch, dragged AND resized (US-092) ----
  // The same defect class as US-089 (drafts left behind by a drag) and US-091
  // (lines left behind by a resize), now for notes. Two fixtures, because a note
  // attaches to a sketch in two different ways: one written ON the photo, and
  // one parked in the white space BESIDE it with an arrow pointing in. The
  // second is the commonest shape a TD writes and the one a box-centre-only rule
  // would silently strand — its arrow would end up pointing at empty board.
  const noteRide = await s.eval(`(async () => {
    const B = window.__BI;
    await B.restore();
    B.clearSelection();
    await B.settle();
    const im0 = B.d.getImages()[0];
    const onPhoto = { x: im0.x + im0.width * 0.30, y: im0.y + im0.height * 0.12 };
    const beside  = { x: im0.x + im0.width + 60, y: im0.y + im0.height * 0.25 };
    const tip     = { x: im0.x + im0.width * 0.70, y: im0.y + im0.height * 0.55 };
    const inside = B.d.addNote('ON THE PHOTO', onPhoto, { color: 'blue', fontSize: 12, boxWidth: 120 });
    const outside = B.d.addNote('BESIDE IT', beside, { color: 'blue', fontSize: 12, boxWidth: 120, leaders: [tip] });
    await B.settle();
    const shot = () => {
      const out = {};
      for (const n of B.d.getNotes()) {
        out[n.id] = { x: n.pos.x, y: n.pos.y, f: n.fontSize, w: n.boxWidth,
          lead: (n.leaders[0] ? [n.leaders[0].x, n.leaders[0].y] : null) };
      }
      return out;
    };

    // --- drag ---
    const beforeDrag = shot();
    const imBefore = B.d.getImages()[0];
    // Press point on the photo furthest from every line, so the drag is claimed
    // by the photo and not by a line or a marquee (US-086 select-then-drag).
    let spot = null, bestClear = -1;
    for (let gx = 1; gx <= 14; gx += 1) for (let gy = 1; gy <= 14; gy += 1) {
      const p = { x: imBefore.x + imBefore.width * gx / 15, y: imBefore.y + imBefore.height * gy / 15 };
      let clear = Infinity;
      for (const a of B.d.getAnnotations()) {
        const vx = a.end.x - a.start.x, vy = a.end.y - a.start.y;
        const len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.start.x) * vx + (p.y - a.start.y) * vy) / len2));
        clear = Math.min(clear, Math.hypot(p.x - (a.start.x + vx * t), p.y - (a.start.y + vy * t)));
      }
      if (clear > bestClear) { bestClear = clear; spot = p; }
    }
    const sp = B.w2s(spot);
    B.ev('mousedown', sp.x, sp.y); B.ev('mouseup', sp.x, sp.y);   // select
    await B.settle();
    B.ev('mousedown', sp.x, sp.y);
    const draggedOpened = (B.d.getInteraction() || {}).type;
    for (let i = 1; i <= 5; i += 1) B.ev('mousemove', sp.x + 90 * i / 5, sp.y + 40 * i / 5);
    B.ev('mouseup', sp.x + 90, sp.y + 40);
    await B.settle();
    const afterDrag = shot();
    const imgDx = B.d.getImages()[0].x - imBefore.x;

    // --- resize, from the state the drag left behind ---
    const imMid = B.d.getImages()[0];
    const beforeResize = shot();
    const se = B.w2s({ x: imMid.x + imMid.width, y: imMid.y + imMid.height });
    B.ev('mousedown', se.x, se.y);
    const resizeOpened = (B.d.getInteraction() || {}).type;
    for (let i = 1; i <= 6; i += 1) B.ev('mousemove', se.x + 120 * i / 6, se.y + 90 * i / 6);
    B.ev('mouseup', se.x + 120, se.y + 90);
    await B.settle();
    const afterResize = shot();
    const imgScale = B.d.getImages()[0].width / imMid.width;
    const anchor = { x: imMid.x, y: imMid.y }; // SE drag scales about the NW corner

    await B.restore();
    return {
      ids: { inside: inside.id, outside: outside.id },
      draggedOpened, resizeOpened, imgDx, imgScale: +imgScale.toFixed(4),
      beforeDrag, afterDrag, beforeResize, afterResize, anchor,
    };
  })()`);
  check(noteRide.draggedOpened === 'drag-image',
    `the photo press opened ${noteRide.draggedOpened} instead of a photo drag — nothing was tested`);
  check(Math.abs(noteRide.imgDx) > 1, `the photo did not move (${noteRide.imgDx}) — nothing was tested`);
  for (const key of ['inside', 'outside']) {
    const id = noteRide.ids[key];
    const b = noteRide.beforeDrag[id];
    const a = noteRide.afterDrag[id];
    check(!!a, `the ${key} note vanished during the drag`);
    check(Math.abs((a.x - b.x) - noteRide.imgDx) < 0.5,
      `the ${key} note did not travel with the photo: photo moved ${noteRide.imgDx.toFixed(2)}, note moved ${(a.x - b.x).toFixed(2)}`);
    if (b.lead) {
      check(Math.abs((a.lead[0] - b.lead[0]) - noteRide.imgDx) < 0.5,
        `the ${key} note's leader stayed behind: it moved ${(a.lead[0] - b.lead[0]).toFixed(2)} against the photo's ${noteRide.imgDx.toFixed(2)} — the arrow would point at empty board`);
    }
  }
  check(noteRide.resizeOpened === 'drag-image-resize',
    `the corner press opened ${noteRide.resizeOpened} instead of a resize — nothing was tested`);
  check(noteRide.imgScale > 1.05, `the photo barely resized (x${noteRide.imgScale}) — nothing was tested`);
  for (const key of ['inside', 'outside']) {
    const id = noteRide.ids[key];
    const b = noteRide.beforeResize[id];
    const a = noteRide.afterResize[id];
    const wantX = noteRide.anchor.x + (b.x - noteRide.anchor.x) * noteRide.imgScale;
    const wantY = noteRide.anchor.y + (b.y - noteRide.anchor.y) * noteRide.imgScale;
    check(Math.hypot(a.x - wantX, a.y - wantY) < 1.5,
      `the ${key} note did not scale about the photo's anchor: expected (${wantX.toFixed(1)}, ${wantY.toFixed(1)}), got (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`);
    check(Math.abs(a.f / b.f - noteRide.imgScale) < 0.01,
      `the ${key} note's type did not scale with the photo: font x${(a.f / b.f).toFixed(3)} against the photo's x${noteRide.imgScale}`);
    check(Math.abs(a.w / b.w - noteRide.imgScale) < 0.01,
      `the ${key} note's wrap width did not scale with the photo: x${(a.w / b.w).toFixed(3)} against x${noteRide.imgScale}`);
  }
  console.log(`board-interaction-check: notes ride the sketch — drag +${noteRide.imgDx.toFixed(1)}, resize x${noteRide.imgScale}, both the on-photo note and the beside-it note with its leader`);

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
