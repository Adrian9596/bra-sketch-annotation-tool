// US-105: DXF Pattern Measurement. Proves the deterministic native-
// coordinate kernel (unit conversion, analytic line/arc length, adaptive
// Bézier length, point projection, partial length, connected-path route
// enumeration with branch/closed-contour handling, direct distance),
// its additive parser adapter (does not disturb US-104's own
// dxf.parse/importText contract), session isolation (never in Project
// JSON, autosave, or the POM measurement set), the real Pattern Measure
// tool driven by real pointer/keyboard events (Along Path, Out of Path,
// route-choosing via Tab/Enter, endpoint/label drag, delete, undo/redo,
// Escape-cancel, mode-switch/reimport cleanup), the active-vs-inactive
// route rendering, and per-piece topology coverage on the real factory
// fixture `demo/DXF file/3380.dxf`. The CLO absolute-value accuracy gate
// (validation.md) is reported BLOCKED, not skipped and not faked, until
// scripts/groundtruth/dxf-measurements/3380.dxf.json carries real
// `td_confirmed` reference values — see that file and this repo's
// TESTING.md for the exact reason.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const appDir = path.dirname(fileURLToPath(import.meta.url)) + '/..';

let server, chrome, userDataDir, passed = 0;
let releaseBlocked = false;
const allowBlocked = process.argv.includes('--allow-blocked');
const cleanup = [];
const check = (ok, msg) => { if (!ok) throw new Error(msg); passed += 1; };
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
const distance2d = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Synthetic DXF fixture builders (same low-level shape as dxf-import-check.mjs) ----
const P = (code, value) => [String(code), String(value)];
const pairsToText = (pairs) => pairs.map(p => p[0] + '\n' + p[1]).join('\n') + '\n';
const sectionBlock = (name, bodyPairs) => [P(0, 'SECTION'), P(2, name), ...bodyPairs, P(0, 'ENDSEC')];
const doc = (entityArrays) => pairsToText([...sectionBlock('ENTITIES', entityArrays.flat()), P(0, 'EOF')]);
const dxfLine = (x1, y1, x2, y2) => [P(0, 'LINE'), P(10, x1), P(20, y1), P(11, x2), P(21, y2)];
const dxfArc = (cx, cy, r, a0, a1) => [P(0, 'ARC'), P(10, cx), P(20, cy), P(40, r), P(50, a0), P(51, a1)];
const dxfCircle = (cx, cy, r) => [P(0, 'CIRCLE'), P(10, cx), P(20, cy), P(40, r)];
const dxfLwpolyline = (verts, closed) => {
  const out = [P(0, 'LWPOLYLINE'), P(90, verts.length), P(70, closed ? 1 : 0)];
  for (const [x, y, bulge] of verts) { out.push(P(10, x), P(20, y)); if (bulge) out.push(P(42, bulge)); }
  return out;
};
// Closed square, side 10, four straight LINEs.
const SQUARE_DXF = doc([dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]);
// Open 5-segment chain along the x axis: (0,0)-(50,0), 10 units apart.
const CHAIN_DXF = doc(Array.from({ length: 5 }, (_, i) => dxfLine(i * 10, 0, (i + 1) * 10, 0)));

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanup.push(() => new Promise(r => server.close(r)));
  const port = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'dxf-measurement-check-'));
  cleanup.push(() => rm(userDataDir, { recursive: true, force: true }).catch(() => {}));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--window-size=1366,900',
    `${started.baseUrl}/index.html?dxfmeasure=${Date.now()}`]);
  cleanup.push(() => new Promise(r => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(port);
  const s = await session(port);
  await s.waitFor('window.__braAutoModeDebug && document.getElementById("modeManualBtn")', 8000);
  s.eval('window.__dxfMeasureErrors = []; window.addEventListener("error", e => window.__dxfMeasureErrors.push(String(e.message)));');

  await section1PureKernel(s);
  await section2RouteEnumeration(s);
  // Section 5 runs here, right after the pure-function-only sections and
  // before section 3/4 ever touch the real board — it needs a guaranteed-
  // fresh board (annotation index 0 must be ITS OWN import's first
  // segment), and every later section's own imports/mode-switches are
  // additive and would otherwise leave stale geometry at low indices.
  await section5Visual(s);
  await section3Integration(s);
  await section4RealPointerFlow(s);
  await section6RealFixture(s);
  await section7ViewportZoomMatrix(s);

  const errors = await s.eval('window.__dxfMeasureErrors');
  check(Array.isArray(errors) && errors.length === 0, 'no uncaught browser errors: ' + JSON.stringify(errors));

  if (releaseBlocked) {
    const message = `BLOCKED  dxf-measurement-check release gate — structural checks passed (${passed}/${passed}), but complete td_confirmed CLO evidence is unavailable`;
    if (!allowBlocked) throw new Error(message + '. Re-run with --allow-blocked only for structural CI.');
    console.log(`STRUCTURAL PASS  dxf-measurement-check   ${passed}/${passed} assertions ok; RELEASE BLOCKED (CLO evidence)`);
  } else {
    console.log(`PASS  dxf-measurement-check   ${passed}/${passed} assertions ok`);
  }
}

async function section7ViewportZoomMatrix(s) {
  // Reuses section 6's real-fixture measurement id=1 (activateMeasurementForEdit)
  // rather than creating its own — same reason section 6 itself skips: no
  // demo/ in the public mirror means no id=1 exists, and every row below
  // would read undefined off an empty routeWorldPoints() result.
  try {
    await readFile(path.join(appDir, 'demo/DXF file/3380.dxf'), 'utf8');
  } catch {
    console.log('SKIP  dxf-measurement-check   demo/DXF file/3380.dxf not present (public mirror) — section 7 skipped');
    return;
  }
  const rows = [];
  for (const width of [1440, 1024, 768]) {
    await s.setViewport(width, 900);
    const viewportRows = await s.eval(`(async () => {
      const dbg=window.__braAutoModeDebug, id=1;
      dbg.dxf.measure.activateMeasurementForEdit(id);
      const base=dbg.dxf.measure.valueInches(id), canvas=document.getElementById('boardCanvas'), out=[];
      const settle=(frames=4)=>new Promise(resolve=>{const step=()=>frames--<=0?resolve():requestAnimationFrame(step);requestAnimationFrame(step);});
      for(const zoom of [.5,1,2,8]){
        const pts=dbg.dxf.measure.routeWorldPoints(id),anchor=pts[Math.floor(pts.length/2)],rect=canvas.getBoundingClientRect();
        dbg.setView({zoom,panX:rect.width/2-anchor.x*zoom,panY:rect.height/2-anchor.y*zoom});
        // Viewport resize can clear the backing buffer in ResizeObserver and
        // queue its repaint one frame after the view repaint. Four frames prove
        // the stable rendered state a TD sees, rather than sampling that
        // intentional one-frame buffer hand-off.
        await settle(4);
        const freshRect=canvas.getBoundingClientRect(),freshPts=dbg.dxf.measure.routeWorldPoints(id),sample=freshPts[Math.floor(freshPts.length/2)];
        const view=dbg.getView(),screen={x:sample.x*view.zoom+view.panX,y:sample.y*view.zoom+view.panY};
        const ctx=canvas.getContext('2d'),dpr=canvas.width/freshRect.width,x=Math.round(screen.x*dpr),y=Math.round(screen.y*dpr);
        const data=ctx.getImageData(Math.max(0,x-4),Math.max(0,y-4),9,9).data;let maxRed=0;
        for(let i=0;i<data.length;i+=4)maxRed=Math.max(maxRed,data[i]);
        const a=dbg.dxf.measure.handleWorldPosition(id,'a'),b=dbg.dxf.measure.handleWorldPosition(id,'b');
        out.push({zoom,value:dbg.dxf.measure.valueInches(id),base,maxRed,
          aScreen:{x:a.x*view.zoom+view.panX,y:a.y*view.zoom+view.panY},
          bScreen:{x:b.x*view.zoom+view.panX,y:b.y*view.zoom+view.panY},
          canvas:{width:freshRect.width,height:freshRect.height}});
      }
      return out;
    })()`);
    rows.push(...viewportRows.map(row => Object.assign({ width }, row)));
  }
  await s.setViewport(1366, 900);
  for (const row of rows) {
    check(near(row.value, row.base, 1e-12), row.width+'px @ '+row.zoom+'x keeps native inches invariant');
    check(row.maxRed > 150, row.width+'px @ '+row.zoom+'x keeps the active route visibly highlighted, evidence='+JSON.stringify(row));
    check(row.aScreen.x >= 0 && row.aScreen.x <= row.canvas.width && row.aScreen.y >= 0 && row.aScreen.y <= row.canvas.height
      && row.bScreen.x >= 0 && row.bScreen.x <= row.canvas.width && row.bScreen.y >= 0 && row.bScreen.y <= row.canvas.height,
      row.width+'px @ '+row.zoom+'x keeps A/B visible in the centered review view');
  }
  console.log('PASS  section 7 (viewport/zoom matrix 3x4)');
}

// ---- Section 1: pure kernel unit tests -------------------------------------
async function section1PureKernel(s) {
  const reasons = await s.eval('window.__braAutoModeDebug.dxf.measure.reasonCodes()');
  check(reasons.NO_CONNECTED_PATH === 'NO_CONNECTED_PATH' && reasons.AMBIGUOUS_ROUTE === 'AMBIGUOUS_ROUTE'
    && reasons.ROUTE_SEARCH_TRUNCATED === 'ROUTE_SEARCH_TRUNCATED'
    && reasons.NON_FINITE_GEOMETRY === 'NON_FINITE_GEOMETRY' && reasons.UNSUPPORTED_GEOMETRY === 'UNSUPPORTED_GEOMETRY'
    && reasons.NO_HIT === 'NO_HIT' && reasons.NO_DXF_SESSION === 'NO_DXF_SESSION',
    'all stable reason codes present: ' + JSON.stringify(reasons));

  const lineLen = await s.eval(`window.__braAutoModeDebug.dxf.measure.segmentLength({kind:'straight', a:{x:0,y:0}, b:{x:3,y:4}})`);
  check(near(lineLen, 5), '3-4-5 straight segment length, got ' + lineLen);

  const arcLen = await s.eval(`window.__braAutoModeDebug.dxf.measure.segmentLength({kind:'arc', center:{x:0,y:0}, radius:10, startAngle:0, sweep:Math.PI})`);
  check(near(arcLen, 10 * Math.PI), 'half-circle arc length = pi*r, got ' + arcLen);

  const circleLen = await s.eval(`window.__braAutoModeDebug.dxf.measure.segmentLength({kind:'arc', center:{x:0,y:0}, radius:5, startAngle:0, sweep:Math.PI*2})`);
  check(near(circleLen, 2 * Math.PI * 5), 'full circle circumference, got ' + circleLen);

  // ARC wraparound: a 350deg -> 10deg entity is a 20deg (not -340deg) sweep,
  // via the real native parser path (same convention US-104's own
  // convertDxfArcEntity uses, verified equal here for the additive adapter).
  const wrap = await s.eval(`window.__braAutoModeDebug.dxf.measure.parseNative(${JSON.stringify(doc([dxfArc(0, 0, 10, 350, 10)]))})`);
  check(wrap.ok && wrap.pieces.length === 1, 'wraparound ARC should parse to one piece');
  const wrapSeg = wrap.pieces[0].segments[0];
  check(wrapSeg.kind === 'arc' && near(wrapSeg.sweep, 20 * Math.PI / 180, 1e-6),
    'wraparound ARC sweep should be 20deg (0.349 rad), got ' + wrapSeg.sweep);

  // Bulge sign convention: a positive bulge and a negative bulge on the same
  // chord curve to opposite sides (opposite-signed sweep).
  const bulges = await s.eval(`window.__braAutoModeDebug.dxf.measure.parseNative(${JSON.stringify(doc([
    dxfLwpolyline([[0, 0, 1], [10, 0, 0]], false),
    dxfLwpolyline([[0, 100, -1], [10, 100, 0]], false),
  ]))})`);
  check(bulges.ok && bulges.pieces.length === 2, 'two independent bulge polylines should parse to two pieces');
  const posBulgeSeg = bulges.pieces.find(p => p.segments[0].center.y < 50).segments[0];
  const negBulgeSeg = bulges.pieces.find(p => p.segments[0].center.y > 50).segments[0];
  check(Math.sign(posBulgeSeg.sweep) !== Math.sign(negBulgeSeg.sweep),
    'opposite-signed bulges should curve to opposite sides (opposite sweep sign), got ' + posBulgeSeg.sweep + ' vs ' + negBulgeSeg.sweep);

  // Adaptive Bézier length: a degenerate cubic whose control points lie
  // exactly on the chord must measure as the chord length, not overshoot.
  const straightBezier = await s.eval(`window.__braAutoModeDebug.dxf.measure.segmentLength({kind:'curve',
    p0:{x:0,y:0}, p1:{x:3.333,y:0}, p2:{x:6.667,y:0}, p3:{x:10,y:0}})`);
  check(near(straightBezier, 10, 1e-3), 'a collinear-control-point cubic should measure as its chord length, got ' + straightBezier);

  // Point projection: onto a straight segment and onto an arc.
  const projStraight = await s.eval(`window.__braAutoModeDebug.dxf.measure.projectPointOnSegment({x:5,y:3}, {kind:'straight', a:{x:0,y:0}, b:{x:10,y:0}})`);
  check(near(projStraight.t, 0.5, 1e-6) && near(projStraight.distance, 3, 1e-6), 'projection onto straight segment, got ' + JSON.stringify(projStraight));
  const projArc = await s.eval(`window.__braAutoModeDebug.dxf.measure.projectPointOnSegment({x:20,y:0}, {kind:'arc', center:{x:0,y:0}, radius:10, startAngle:0, sweep:Math.PI/2})`);
  check(near(projArc.distance, 10, 1e-6) && near(projArc.t, 0, 1e-6), 'projection of an outside-the-sweep point clamps to the nearest endpoint, got ' + JSON.stringify(projArc));

  // Partial length: whole = sum of two halves, for both line and arc.
  const lineSeg = `{kind:'straight', a:{x:0,y:0}, b:{x:10,y:0}}`;
  const halfA = await s.eval(`window.__braAutoModeDebug.dxf.measure.partialLength(${lineSeg}, 0, 0.5)`);
  const halfB = await s.eval(`window.__braAutoModeDebug.dxf.measure.partialLength(${lineSeg}, 0.5, 1)`);
  check(near(halfA + halfB, 10, 1e-6), 'line partial-length halves should sum to the whole, got ' + halfA + '+' + halfB);
  const arcSeg = `{kind:'arc', center:{x:0,y:0}, radius:10, startAngle:0, sweep:Math.PI}`;
  const arcHalfA = await s.eval(`window.__braAutoModeDebug.dxf.measure.partialLength(${arcSeg}, 0, 0.5)`);
  const arcHalfB = await s.eval(`window.__braAutoModeDebug.dxf.measure.partialLength(${arcSeg}, 0.5, 1)`);
  check(near(arcHalfA + arcHalfB, 10 * Math.PI, 1e-6), 'arc partial-length halves should sum to the whole, got ' + arcHalfA + '+' + arcHalfB);

  // Direct distance: symmetric, and non-finite input never coerces to 0.
  const dd1 = await s.eval('window.__braAutoModeDebug.dxf.measure.directDistance({x:1,y:2},{x:4,y:6})');
  const dd2 = await s.eval('window.__braAutoModeDebug.dxf.measure.directDistance({x:4,y:6},{x:1,y:2})');
  check(near(dd1, 5) && near(dd1, dd2), 'direct distance symmetric 3-4-5, got ' + dd1 + ' / ' + dd2);
  const ddNaN = await s.eval('window.__braAutoModeDebug.dxf.measure.directDistance({x:NaN,y:0},{x:1,y:1})');
  check(ddNaN === null, 'direct distance on non-finite input should be null, not 0, got ' + ddNaN);

  // Reason codes on bad input to the route enumerator.
  const badRef = await s.eval(`window.__braAutoModeDebug.dxf.measure.enumerateRoutesRaw(
    [{kind:'straight', a:{x:0,y:0}, b:{x:1,y:0}}], {segIndex: 5, t: 0.5}, {segIndex: 0, t: 0.5})`);
  check(!badRef.ok && badRef.reason === reasons.NON_FINITE_GEOMETRY, 'out-of-range segIndex should report NON_FINITE_GEOMETRY, got ' + JSON.stringify(badRef));
  const emptyGraph = await s.eval(`window.__braAutoModeDebug.dxf.measure.enumerateRoutesRaw([], {segIndex:0,t:0}, {segIndex:0,t:0})`);
  check(!emptyGraph.ok && emptyGraph.reason === reasons.NO_CONNECTED_PATH, 'empty segment list should report NO_CONNECTED_PATH, got ' + JSON.stringify(emptyGraph));

  // Unit resolution.
  const mmUnit = await s.eval('window.__braAutoModeDebug.dxf.measure.resolveNativeToInch(4)');
  check(mmUnit.unitSource === 'dxf-header' && mmUnit.factor > 0.0393 && mmUnit.factor < 0.0394, 'mm unit code resolves to dxf-header + correct factor, got ' + JSON.stringify(mmUnit));
  const noUnit = await s.eval('window.__braAutoModeDebug.dxf.measure.resolveNativeToInch(null)');
  check(noUnit.unitSource === 'default-inch' && noUnit.factor === 1, 'no declared unit resolves to default-inch + factor 1, got ' + JSON.stringify(noUnit));

  const units = await s.eval(`([1,2,4,5,6,21,0,99]).map(code => [code, window.__braAutoModeDebug.dxf.measure.resolveNativeToInch(code)])`);
  const expectedFactors = new Map([[1, 1], [2, 12], [4, 1 / 25.4], [5, 1 / 2.54], [6, 1 / 0.0254], [21, (1200 / 3937) / 0.0254]]);
  for (const [code, unit] of units) {
    if (expectedFactors.has(code)) check(near(unit.factor, expectedFactors.get(code), 1e-10) && unit.unitSource === 'dxf-header', '$INSUNITS ' + code + ' factor/provenance, got ' + JSON.stringify(unit));
    else check(unit.unitSource === 'unsupported-explicit-unit' && unit.diagnostic && unit.factor === 1, 'unsupported explicit $INSUNITS ' + code + ' is diagnostic, got ' + JSON.stringify(unit));
  }

  const invalids = await s.eval(`(() => {
    const d = window.__braAutoModeDebug.dxf.measure;
    const zero = {kind:'straight',a:{x:1,y:1},b:{x:1,y:1}};
    const badArc = {kind:'arc',center:{x:0,y:0},radius:-1,startAngle:0,sweep:1};
    return {
      zeroIsNaN: Number.isNaN(d.segmentLength(zero)),
      zeroReason: d.segmentFailureReason(zero),
      badArcIsNaN: Number.isNaN(d.segmentLength(badArc)),
      badArcReason: d.segmentFailureReason(badArc),
      unknownIsNaN: Number.isNaN(d.segmentLength({kind:'spline'})),
    };
  })()`);
  check(invalids.zeroIsNaN && invalids.zeroReason === reasons.UNSUPPORTED_GEOMETRY, 'zero-length straight is explicit invalid, got ' + JSON.stringify(invalids));
  check(invalids.badArcIsNaN && invalids.badArcReason === reasons.UNSUPPORTED_GEOMETRY, 'degenerate arc is explicit invalid, got ' + JSON.stringify(invalids));
  check(invalids.unknownIsNaN, 'unsupported segment kind must never become numeric zero');

  const repeated = await s.eval(`window.__braAutoModeDebug.dxf.measure.parseNative(${JSON.stringify(doc([
    dxfLwpolyline([[0,0,0],[0,0,0],[10,0,0]], false),
  ]))})`);
  check(repeated.ok && repeated.buckets && repeated.buckets.rejectedDegenerateSegments === 1
    && repeated.pieces[0].segments.length === 1,
    'repeated polyline hop is rejected individually while valid hops remain measurable, got ' + JSON.stringify(repeated));

  const clockwiseStart = await s.eval(`window.__braAutoModeDebug.dxf.measure.projectPointOnSegment(
    {x:10,y:0}, {kind:'arc',center:{x:0,y:0},radius:10,startAngle:0,sweep:-Math.PI/2})`);
  check(near(clockwiseStart.t, 0, 1e-12), 'clockwise arc exact start projects to t=0, got ' + JSON.stringify(clockwiseStart));

  const bezierProjection = await s.eval(`(() => {
    const d = window.__braAutoModeDebug.dxf.measure;
    const seg = {kind:'curve',p0:{x:0,y:0},p1:{x:0,y:100},p2:{x:100,y:100},p3:{x:100,y:0}};
    const point = {x:49,y:61};
    const got = d.projectPointOnSegment(point, seg);
    let best = Infinity;
    for (let i=0;i<=200000;i+=1) {
      const t=i/200000, mt=1-t;
      const x=mt*mt*mt*seg.p0.x+3*mt*mt*t*seg.p1.x+3*mt*t*t*seg.p2.x+t*t*t*seg.p3.x;
      const y=mt*mt*mt*seg.p0.y+3*mt*mt*t*seg.p1.y+3*mt*t*t*seg.p2.y+t*t*t*seg.p3.y;
      best=Math.min(best,Math.hypot(x-point.x,y-point.y));
    }
    return {got,best};
  })()`);
  check(Math.abs(bezierProjection.got.distance - bezierProjection.best) < 1e-5, 'Bezier projection distance matches an independent dense oracle, got ' + JSON.stringify(bezierProjection));
  console.log('PASS  section 1 (pure kernel unit tests)');
}

// ---- Section 2: route enumeration on synthetic fixtures --------------------
async function section2RouteEnumeration(s) {
  const parsed = await s.eval(`window.__braAutoModeDebug.dxf.measure.parseNative(${JSON.stringify(SQUARE_DXF)})`);
  check(parsed.ok && parsed.pieces.length === 1 && parsed.pieces[0].segments.length === 4, 'square: one piece, four native segments');
  const squareSegs = JSON.stringify(parsed.pieces[0].segments);
  const squareRoutes = await s.eval(`window.__braAutoModeDebug.dxf.measure.enumerateRoutesRaw(${squareSegs}, {segIndex:0,t:0.5}, {segIndex:2,t:0.5})`);
  check(squareRoutes.ok && squareRoutes.routes.length === 2, 'square: opposite-side A/B has exactly 2 routes, got ' + JSON.stringify(squareRoutes.routes && squareRoutes.routes.length));
  const total = squareRoutes.routes[0].length + squareRoutes.routes[1].length;
  check(near(total, 40, 1e-6), 'square: complementary route lengths sum to the 40-unit perimeter, got ' + total);
  check(near(Math.min(squareRoutes.routes[0].length, squareRoutes.routes[1].length), 20, 1e-6), 'square: short route is exactly 2 sides = 20, got ' + Math.min(squareRoutes.routes[0].length, squareRoutes.routes[1].length));
  for (const r of squareRoutes.routes) {
    const viaSteps = await s.eval(`window.__braAutoModeDebug.dxf.measure.routeLength(${JSON.stringify(r)}, ${squareSegs})`);
    check(near(viaSteps, r.length, 1e-6), 'square route: routeLength(route) matches its own .length (the highlighted route IS the measured route)');
  }

  const chainParsed = await s.eval(`window.__braAutoModeDebug.dxf.measure.parseNative(${JSON.stringify(CHAIN_DXF)})`);
  check(chainParsed.ok && chainParsed.pieces.length === 1 && chainParsed.pieces[0].segments.length === 5, 'chain: one piece, five native segments');
  const chainSegs = JSON.stringify(chainParsed.pieces[0].segments);
  const chainRoutes = await s.eval(`window.__braAutoModeDebug.dxf.measure.enumerateRoutesRaw(${chainSegs}, {segIndex:0,t:0.4}, {segIndex:4,t:0.6})`);
  check(chainRoutes.ok && chainRoutes.routes.length === 1, 'open chain: exactly one route, got ' + JSON.stringify(chainRoutes.routes && chainRoutes.routes.length));
  const reversed = await s.eval(`window.__braAutoModeDebug.dxf.measure.reverseRoute(${JSON.stringify(chainRoutes.routes[0])})`);
  const reversedLen = await s.eval(`window.__braAutoModeDebug.dxf.measure.routeLength(${JSON.stringify(reversed)}, ${chainSegs})`);
  check(near(reversedLen, chainRoutes.routes[0].length, 1e-6), 'open chain: forward/reverse magnitudes match, got ' + reversedLen + ' vs ' + chainRoutes.routes[0].length);

  const twoIslands = JSON.stringify([
    { kind: 'straight', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
    { kind: 'straight', a: { x: 500, y: 500 }, b: { x: 501, y: 500 } },
  ]);
  const islandResult = await s.eval(`window.__braAutoModeDebug.dxf.measure.enumerateRoutesRaw(${twoIslands}, {segIndex:0,t:0.5}, {segIndex:1,t:0.5})`);
  check(!islandResult.ok && islandResult.reason === 'NO_CONNECTED_PATH', 'two disjoint segments report NO_CONNECTED_PATH, got ' + JSON.stringify(islandResult));

  const topology = await s.eval(`(() => {
    const d=window.__braAutoModeDebug.dxf.measure;
    const below=[{kind:'straight',a:{x:0,y:0},b:{x:1,y:0}},{kind:'straight',a:{x:1.009,y:0},b:{x:2,y:0}}];
    const above=[{kind:'straight',a:{x:0,y:0},b:{x:1,y:0}},{kind:'straight',a:{x:1.011,y:0},b:{x:2,y:0}}];
    return {
      below:d.enumerateRoutesRaw(below,{segIndex:0,t:.5},{segIndex:1,t:.5},.01),
      above:d.enumerateRoutesRaw(above,{segIndex:0,t:.5},{segIndex:1,t:.5},.01),
    };
  })()`);
  check(topology.below.ok, 'endpoints below the explicit topology tolerance connect');
  check(!topology.above.ok && topology.above.reason === 'NO_CONNECTED_PATH', 'endpoints above the explicit topology tolerance stay disconnected');

  const crossing = await s.eval(`window.__braAutoModeDebug.dxf.measure.enumerateRoutesRaw([
    {kind:'straight',a:{x:-1,y:0},b:{x:1,y:0}},
    {kind:'straight',a:{x:0,y:-1},b:{x:0,y:1}}
  ],{segIndex:0,t:.25},{segIndex:1,t:.75},1e-6)`);
  check(!crossing.ok && crossing.reason === 'NO_CONNECTED_PATH', 'visual crossings without authored split points remain topologically disconnected');

  const capped = await s.eval(`(() => {
    const segs=[{kind:'straight',a:{x:-1,y:0},b:{x:0,y:0}}];
    for(let stage=0;stage<5;stage+=1){const x=stage*2;segs.push(
      {kind:'straight',a:{x,y:0},b:{x:x+1,y:1}}, {kind:'straight',a:{x:x+1,y:1},b:{x:x+2,y:0}},
      {kind:'straight',a:{x,y:0},b:{x:x+1,y:-1}}, {kind:'straight',a:{x:x+1,y:-1},b:{x:x+2,y:0}});}
    segs.push({kind:'straight',a:{x:10,y:0},b:{x:11,y:0}});
    return window.__braAutoModeDebug.dxf.measure.enumerateRoutesRaw(segs,{segIndex:0,t:.5},{segIndex:21,t:.5},1e-9);
  })()`);
  check(!capped.ok && capped.truncated && capped.reason === 'ROUTE_SEARCH_TRUNCATED' && capped.routes.length === 0,
    'route-cap overflow is an explicit non-committable result, got ' + JSON.stringify(capped));

  const directionScores = await s.eval(`(() => {
    const d=window.__braAutoModeDebug.dxf.measure;
    return ${JSON.stringify(squareRoutes.routes)}.map(r => d.routeAuthoredDirectionScore(r, ${squareSegs}));
  })()`);
  check(directionScores.some(v => v > 0) && directionScores.some(v => v < 0), 'closed-square directions derive from authored traversal, not candidate index: ' + JSON.stringify(directionScores));
  console.log('PASS  section 2 (route enumeration on synthetic fixtures)');
}

// ---- Section 3: integration / isolation -------------------------------------
async function section3Integration(s) {
  const compat = await s.eval(`(() => {
    const oldParse = window.__braAutoModeDebug.dxf.parse(${JSON.stringify(SQUARE_DXF)});
    const nativeParse = window.__braAutoModeDebug.dxf.measure.parseNative(${JSON.stringify(SQUARE_DXF)});
    return { oldPieceCount: oldParse.pieces.length, oldSegCount: oldParse.pieces[0].length,
      nativePieceCount: nativeParse.pieces.length, nativeSegCount: nativeParse.pieces[0].segments.length };
  })()`);
  check(compat.oldPieceCount === compat.nativePieceCount && compat.oldSegCount === compat.nativeSegCount,
    'the additive native parser agrees with the untouched parseDxfDocument on piece/segment counts for an all-straight fixture: ' + JSON.stringify(compat));

  const isolation = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('dxfImportFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(SQUARE_DXF)}], 'square.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    document.getElementById('toolsMenuBtn').click();
    document.getElementById('dxfMeasureAlongBtn').click();
    const dbg = window.__braAutoModeDebug;
    // This is the suite's first real import in its one continuous browser
    // session, so the board is empty beforehand — slice(-4) is a no-op here
    // but keeps the convention consistent with the later sections that
    // genuinely need it (see section5Visual's comment).
    const anns = dbg.getAnnotations().slice(-4);
    const ann0 = anns[0], ann2 = anns[2];
    const canvas = document.getElementById('boardCanvas');
    const rect = canvas.getBoundingClientRect();
    const view = dbg.getView();
    const toScreen = (w) => ({ x: rect.left + w.x * view.zoom + view.panX, y: rect.top + w.y * view.zoom + view.panY });
    const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));
    const confirmChoices = async () => {
      for (let i = 0; i < 6; i += 1) {
        const pending = dbg.dxf.measure.getSession().interaction;
        if (!pending || (pending.type !== 'choosing-entity' && pending.type !== 'choosing-route')) return;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise(r => requestAnimationFrame(r));
      }
    };
    const sa = toScreen({ x: (ann0.start.x + ann0.end.x) / 2, y: (ann0.start.y + ann0.end.y) / 2 });
    const sb = toScreen({ x: (ann2.start.x + ann2.end.x) / 2, y: (ann2.start.y + ann2.end.y) / 2 });
    fire('mousedown', sa.x, sa.y); fire('mouseup', sa.x, sa.y);
    fire('mousedown', sb.x, sb.y); fire('mouseup', sb.x, sb.y);
    await confirmChoices();
    if (dbg.dxf.measure.getSession().interaction && dbg.dxf.measure.getSession().interaction.type === 'choosing-route') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    const measurementCount = dbg.dxf.measure.getSession().measurementCount;
    const projectJson = JSON.stringify(dbg.exportProject());
    const autosavePeek = dbg.autosave.peek() || '';
    return {
      measurementCount,
      projectHasSessionKey: projectJson.indexOf('dxfMeasureSession') !== -1,
      autosaveHasSessionKey: autosavePeek.indexOf('dxfMeasureSession') !== -1,
      measurementAnnIds: dbg.getMeasurementAnnIds(),
    };
  })()`);
  check(isolation.measurementCount === 1, 'one measurement created for the isolation check, got ' + isolation.measurementCount);
  check(!isolation.projectHasSessionKey, 'Project JSON (exportProject) must never contain the measure session');
  check(!isolation.autosaveHasSessionKey, 'the autosave payload must never contain the measure session');
  check(Array.isArray(isolation.measurementAnnIds), 'getMeasurementAnnIds() should still return the (unrelated) POM measurement set');
  console.log('PASS  section 3 (integration / isolation)');
}

// ---- Section 4: real pointer/keyboard flow ----------------------------------
async function section4RealPointerFlow(s) {
  const flow = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));
    const importFixture = async (text) => {
      document.getElementById('toolsMenuBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const input = document.getElementById('dxfImportFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'f.dxf', { type: 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    };
    await importFixture(${JSON.stringify(SQUARE_DXF)});
    document.getElementById('toolsMenuBtn').click();
    document.getElementById('dxfMeasureAlongBtn').click();
    // slice(-4): section 3 already imported a square before this section
    // runs (one continuous browser session) — always take THIS import's own
    // 4 fresh segments, never section 3's stale leftovers at index 0.
    const anns = () => dbg.getAnnotations().slice(-4);
    const toScreen = (w) => {
      const rect = canvas.getBoundingClientRect();
      const view = dbg.getView();
      return { x: rect.left + w.x * view.zoom + view.panX, y: rect.top + w.y * view.zoom + view.panY };
    };
    const mid = (ann) => ({ x: (ann.start.x + ann.end.x) / 2, y: (ann.start.y + ann.end.y) / 2 });

    // Escape cancels an in-progress placement without creating a measurement.
    const a0 = anns()[0];
    let s0 = toScreen(mid(a0));
    fire('mousedown', s0.x, s0.y); fire('mouseup', s0.x, s0.y);
    const afterFirstClick = dbg.dxf.measure.getSession().interaction;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const afterEscape = dbg.dxf.measure.getSession();

    // Along Path with route-choosing (square -> 2 candidates), Tab cycles, Enter confirms.
    const a2 = anns()[2];
    let sB = toScreen(mid(a2));
    fire('mousedown', s0.x, s0.y); fire('mouseup', s0.x, s0.y);
    fire('mousedown', sB.x, sB.y); fire('mouseup', sB.x, sB.y);
    const choosing = dbg.dxf.measure.getSession().interaction;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const afterAlongPath = dbg.dxf.measure.getSession();

    // Out of Path: two arbitrary clicks always succeed, no ambiguity.
    document.getElementById('toolsMenuBtn').click();
    document.getElementById('dxfMeasureOutBtn').click();
    const rect = canvas.getBoundingClientRect();
    fire('mousedown', rect.left + 20, rect.top + 20); fire('mouseup', rect.left + 20, rect.top + 20);
    fire('mousedown', rect.left + 120, rect.top + 90); fire('mouseup', rect.left + 120, rect.top + 90);
    const afterOutOfPath = dbg.dxf.measure.getSession();

    // Delete the selected (most recent) measurement, then Undo restores it.
    const beforeDelete = afterOutOfPath.measurementCount;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    const afterDelete = dbg.dxf.measure.getSession().measurementCount;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    const afterUndo = dbg.dxf.measure.getSession().measurementCount;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }));
    const afterRedo = dbg.dxf.measure.getSession().measurementCount;

    // Re-importing clears every measurement (a fresh session, not an accumulation).
    await importFixture(${JSON.stringify(SQUARE_DXF)});
    const afterReimport = dbg.dxf.measure.getSession().measurementCount;

    // Switching to Auto Mode clears the session entirely.
    document.getElementById('modeAutoBtn').click();
    const sessionAfterAutoSwitch = dbg.dxf.measure.getSession();

    return {
      afterFirstClickType: afterFirstClick && afterFirstClick.type,
      afterEscapeInteraction: afterEscape.interaction,
      afterEscapeCount: afterEscape.measurementCount,
      choosingType: choosing && choosing.type,
      afterAlongPathCount: afterAlongPath.measurementCount,
      afterOutOfPathCount: afterOutOfPath.measurementCount,
      beforeDelete, afterDelete, afterUndo, afterRedo,
      afterReimport, sessionAfterAutoSwitch,
    };
  })()`);
  check(flow.afterFirstClickType === 'awaiting-b', 'first click should enter awaiting-b, got ' + flow.afterFirstClickType);
  check(flow.afterEscapeInteraction === null, 'Escape should clear the in-progress interaction');
  check(flow.afterEscapeCount === 0, 'Escape must not create a measurement, got count=' + flow.afterEscapeCount);
  check(flow.choosingType === 'choosing-route', 'square A/B should require explicit route choice, got ' + flow.choosingType);
  check(flow.afterAlongPathCount === 1, 'one Along Path measurement after Tab+Enter, got ' + flow.afterAlongPathCount);
  check(flow.afterOutOfPathCount === 2, 'Out of Path adds a second measurement, got ' + flow.afterOutOfPathCount);
  check(flow.beforeDelete === 2 && flow.afterDelete === 1, 'Delete removes exactly the selected measurement, got before=' + flow.beforeDelete + ' after=' + flow.afterDelete);
  check(flow.afterUndo === 2, 'Undo restores the deleted measurement, got ' + flow.afterUndo);
  check(flow.afterRedo === 1, 'Redo re-deletes it, got ' + flow.afterRedo);
  check(flow.afterReimport === 0, 're-importing a DXF clears every prior measurement, got ' + flow.afterReimport);
  check(flow.sessionAfterAutoSwitch === null, 'switching to Auto Mode clears the measure session entirely, got ' + JSON.stringify(flow.sessionAfterAutoSwitch));
  console.log('PASS  section 4 (real pointer/keyboard flow)');
}

// ---- Section 5: visual (active vs inactive route weight) -------------------
async function section5Visual(s) {
  const visual = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('dxfImportFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(CHAIN_DXF)}], 'chain.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    document.getElementById('fitBtn').click();
    // Deselect the just-imported sketch-elements first — US-104's own
    // multi-select halo (blue, ~16px wide) would otherwise sit under BOTH
    // measurements uniformly and swamp any active-vs-inactive comparison
    // that reads pixel alpha instead of colour, since the background is
    // already fully opaque there either way.
    dbg.clearSelection();
    document.getElementById('toolsMenuBtn').click();
    document.getElementById('dxfMeasureAlongBtn').click();
    const canvas = document.getElementById('boardCanvas');
    const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));
    const confirmChoices = async () => {
      for (let i = 0; i < 6; i += 1) {
        const pending = dbg.dxf.measure.getSession().interaction;
        if (!pending || (pending.type !== 'choosing-entity' && pending.type !== 'choosing-route')) return;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise(r => requestAnimationFrame(r));
      }
    };
    const toScreen = (w) => {
      const rect = canvas.getBoundingClientRect();
      const view = dbg.getView();
      return { x: rect.left + w.x * view.zoom + view.panX, y: rect.top + w.y * view.zoom + view.panY };
    };
    // This suite runs every section in ONE continuous browser session
    // (matching dxf-import-check.mjs's own convention), and DXF import is
    // additive — by this point the board already carries annotations from
    // earlier sections' imports. slice(-5) takes exactly this fixture's own
    // 5 fresh segments (always appended last), never an earlier section's
    // stale, differently-shaped leftovers at index 0.
    const anns = dbg.getAnnotations().slice(-5);
    // Click near each segment's OWN start/end (t~0.1/0.9), not its
    // midpoint — clicking at the midpoint would place the route's endpoint
    // (A or B) almost exactly at the sample point used below, landing the
    // pixel probe right on the route's own anti-aliased boundary edge
    // instead of safely inside the drawn stroke.
    const near10 = (ann) => ({ x: ann.start.x + (ann.end.x - ann.start.x) * 0.1, y: ann.start.y + (ann.end.y - ann.start.y) * 0.1 });
    const near90 = (ann) => ({ x: ann.start.x + (ann.end.x - ann.start.x) * 0.9, y: ann.start.y + (ann.end.y - ann.start.y) * 0.9 });
    const mid = (ann) => ({ x: (ann.start.x + ann.end.x) / 2, y: (ann.start.y + ann.end.y) / 2 });
    // Measurement 1 (segments 0-1) is placed first, then becomes INACTIVE
    // the moment measurement 2 is placed after it. Sampled at segment 0's
    // own midpoint, which the resulting route (t~0.1 to 1) safely covers.
    // Each click gets its own confirmChoices() — near10/near90 land close
    // enough to a segment JUNCTION that point A itself can open its own
    // choosing-entity (two chain segments meet there), not just the final
    // A-B pair; resolving only after BOTH clicks left that first choice
    // pending forever and silently swallowed the second click (onMouseDown
    // no-ops during choosing-entity/choosing-route, per its own contract).
    let sa = toScreen(near10(anns[0])), sb = toScreen(near90(anns[1]));
    fire('mousedown', sa.x, sa.y); fire('mouseup', sa.x, sa.y);
    await confirmChoices();
    fire('mousedown', sb.x, sb.y); fire('mouseup', sb.x, sb.y);
    await confirmChoices();
    const inactiveNative = mid(anns[0]);
    let sc = toScreen(near10(anns[2])), sd = toScreen(near90(anns[3]));
    fire('mousedown', sc.x, sc.y); fire('mouseup', sc.x, sc.y);
    await confirmChoices();
    fire('mousedown', sd.x, sd.y); fire('mouseup', sd.x, sd.y);
    await confirmChoices();
    const activeNative = mid(anns[2]);
    await new Promise(r => requestAnimationFrame(r));
    const ctx = canvas.getContext('2d');
    // Recompute screen position from the current rect/view HERE, right
    // before sampling — a status-bar/toast reflow between the clicks above
    // and this point can shift the canvas's on-page position, and reusing
    // an earlier toScreen() result would then sample the wrong pixels even
    // though the render itself is correct (confirmed via a raw screenshot
    // at the point this bug was diagnosed).
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const view = dbg.getView();
    const toScreenNow = (w) => ({ x: rect.left + w.x * view.zoom + view.panX, y: rect.top + w.y * view.zoom + view.panY });
    const inactiveSample = toScreenNow(inactiveNative);
    const activeSample = toScreenNow(activeNative);
    // The background (a thin black DXF line) is opaque either way, so alpha
    // alone cannot distinguish active from inactive — what differs is how
    // much of the orange measure colour (globalAlpha 0.95 active vs 0.55
    // inactive) is mixed in, which reads out as a higher RED channel value.
    const sampleRed = (screenPoint) => {
      const x = Math.round((screenPoint.x - rect.left) * dpr);
      const y = Math.round((screenPoint.y - rect.top) * dpr);
      const data = ctx.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
      let maxRed = 0;
      for (let i = 0; i < data.length; i += 4) maxRed = Math.max(maxRed, data[i]);
      return maxRed;
    };
    return { inactiveRed: sampleRed(inactiveSample), activeRed: sampleRed(activeSample) };
  })()`);
  check(visual.activeRed > 150, 'the active measurement route should mix in a visibly strong orange tint (red channel), got ' + visual.activeRed);
  check(visual.activeRed > visual.inactiveRed,
    'the active route should read a stronger orange mix than an inactive one (heavier/more opaque, per the checklist) — active red=' + visual.activeRed + ' inactive red=' + visual.inactiveRed);
  console.log('PASS  section 5 (visual active vs inactive route weight)');
}

// ---- Section 6: real factory fixture ----------------------------------------
async function section6RealFixture(s) {
  let fixtureText;
  try {
    fixtureText = await readFile(path.join(appDir, 'demo/DXF file/3380.dxf'), 'utf8');
  } catch {
    console.log('SKIP  dxf-measurement-check   demo/DXF file/3380.dxf not present (public mirror) — section 6 skipped');
    return;
  }
  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('dxfImportFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(fixtureText)}], '3380.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40; i += 1) await new Promise(r => requestAnimationFrame(r));
    const dbg = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const settle = (frames=2) => new Promise(resolve => {
      const step = () => frames-- <= 0 ? resolve() : requestAnimationFrame(step);
      requestAnimationFrame(step);
    });
    const toScreen = world => {
      const rect = canvas.getBoundingClientRect(), view = dbg.getView();
      return { x: rect.left + world.x * view.zoom + view.panX, y: rect.top + world.y * view.zoom + view.panY };
    };
    const fireWorld = (type, world) => {
      const p = toScreen(world);
      canvas.dispatchEvent(new MouseEvent(type, {clientX:p.x,clientY:p.y,bubbles:true,button:0}));
    };
    const clickWorld = async world => { fireWorld('mousedown', world); fireWorld('mouseup', world); await settle(1); };
    const press = (key, extra={}) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({key,bubbles:true},extra)));
    const pointOn = (seg,t) => seg.kind === 'straight'
      ? {x:seg.a.x+(seg.b.x-seg.a.x)*t,y:seg.a.y+(seg.b.y-seg.a.y)*t}
      : {x:seg.center.x+Math.cos(seg.startAngle+seg.sweep*t)*seg.radius,y:seg.center.y+Math.sin(seg.startAngle+seg.sweep*t)*seg.radius};
    const resolveEntity = async ref => {
      let pending = dbg.dxf.measure.getSession().interaction;
      if (!pending || pending.type !== 'choosing-entity') return;
      const idx = pending.hits.findIndex(hit => hit.pieceIndex === ref.pieceIndex && hit.segIndexInPiece === ref.segIndexInPiece);
      if (idx < 0) throw new Error('intended entity is absent from explicit candidate set');
      let guard=0;
      while (pending.chosenIndex !== idx && guard++ < pending.hits.length+2) {
        dbg.dxf.measure.cycleChoice(1); await settle(1); pending = dbg.dxf.measure.getSession().interaction;
      }
      if(!pending || pending.chosenIndex!==idx) throw new Error('entity chooser did not advance to intended candidate');
      dbg.dxf.measure.confirmChoice(); await settle(1);
    };
    const clickRef = async ref => {
      const seg = dbg.dxf.measure.pieceSegments(ref.pieceIndex)[ref.segIndexInPiece];
      await clickWorld(dbg.dxf.measure.nativeToBoardLive(pointOn(seg,ref.t),ref.pieceIndex));
      await resolveEntity(ref);
    };
    const chooseRoute = async (direction, routeIndex) => {
      let pending = dbg.dxf.measure.getSession().interaction;
      if (!pending || pending.type !== 'choosing-route') throw new Error('expected '+direction+' route/direction chooser after '+dbg.dxf.measure.getSession().measurementCount+' measurements; got '+JSON.stringify(pending));
      const idx = pending.candidates.findIndex(candidate => candidate.direction === direction
        && (routeIndex == null || candidate.routeIndex === routeIndex));
      if (idx < 0) throw new Error('requested '+direction+' candidate routeIndex='+routeIndex+' is unavailable in '+JSON.stringify(pending.candidates));
      let guard=0;
      while (pending.chosenIndex !== idx && guard++ < pending.candidates.length+2) { dbg.dxf.measure.cycleChoice(1); await settle(1); pending=dbg.dxf.measure.getSession().interaction; }
      if(!pending || pending.chosenIndex!==idx) throw new Error('route chooser did not advance to intended candidate idx='+idx+' pending='+JSON.stringify(pending));
      dbg.dxf.measure.confirmChoice(); await settle(1);
    };
    const findPair = (pieceIndex,direction,avoid) => {
      const segments=dbg.dxf.measure.pieceSegments(pieceIndex);
      const tol=dbg.dxf.measure.getSession().topologyToleranceNative;
      const endpoints=seg=>[pointOn(seg,0),pointOn(seg,1)];
      const parent=segments.map((_,index)=>index);
      const root=index=>{while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}return index;};
      const join=(a,b)=>{a=root(a);b=root(b);if(a!==b)parent[b]=a;};
      for(let i=0;i<segments.length;i+=1){
        const ei=endpoints(segments[i]);
        for(let j=i+1;j<segments.length;j+=1){
          const ej=endpoints(segments[j]);
          let connected=false;
          for(let ai=0;ai<2&&!connected;ai+=1) for(let bj=0;bj<2;bj+=1)
            if(Math.hypot(ei[ai].x-ej[bj].x,ei[ai].y-ej[bj].y)<=tol){connected=true;break;}
          if(connected)join(i,j);
        }
      }
      const groups=new Map();
      segments.forEach((_,index)=>{const key=root(index);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(index);});
      const acceptedPair=(a,b)=>{
        const result=dbg.dxf.measure.enumerateRoutes(a,b);
        if(!result.ok) return null;
        const routeIndex=result.routes.findIndex(route=>!route.steps.some(step=>avoid.has(step.segIndex)));
        return routeIndex<0?null:{a,b,route:result.routes[routeIndex],routeIndex};
      };
      const components=[...groups.values()].filter(group=>!group.some(index=>avoid.has(index))).sort((a,b)=>a.length-b.length||a[0]-b[0]);
      for(const group of components){
        const i=group.slice().sort((a,b)=>{
          const a0=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[a],.3),pieceIndex),a1=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[a],.7),pieceIndex);
          const b0=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[b],.3),pieceIndex),b1=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[b],.7),pieceIndex);
          return Math.hypot(b1.x-b0.x,b1.y-b0.y)-Math.hypot(a1.x-a0.x,a1.y-a0.y);
        })[0];
        const a={pieceIndex,segIndexInPiece:i,t:.3}, b={pieceIndex,segIndexInPiece:i,t:.7};
        const aw=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[i],a.t),pieceIndex),bw=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[i],b.t),pieceIndex);
        if(Math.hypot(aw.x-bw.x,aw.y-bw.y)*dbg.getView().zoom>=4){
          const pair=acceptedPair(a,b); if(pair)return pair;
        }
        let far=null,farDistance=-1;
        for(let ai=0;ai<group.length;ai+=1)for(let bi=ai+1;bi<group.length;bi+=1){
          const wa=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[group[ai]],.5),pieceIndex);
          const wb=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[group[bi]],.5),pieceIndex);
          const d=Math.hypot(wa.x-wb.x,wa.y-wb.y)*dbg.getView().zoom;
          if(d>farDistance){farDistance=d;far={a:{pieceIndex,segIndexInPiece:group[ai],t:.5},b:{pieceIndex,segIndexInPiece:group[bi],t:.5}};}
        }
        if(far&&farDistance>=4){const pair=acceptedPair(far.a,far.b);if(pair)return pair;}
      }
      return null;
    };
    const createAlong = async (pair,direction) => {
      document.getElementById('toolsMenuBtn').click(); document.getElementById('dxfMeasureAlongBtn').click();
      await clickRef(pair.a); await clickRef(pair.b); await chooseRoute(direction,null);
      const session=dbg.dxf.measure.getSession();
      return session.measurements[session.measurements.length-1];
    };
    const dragEndpoint = async (measurementId,which) => {
      let session=dbg.dxf.measure.getSession();
      if(session.selectedMeasurementId!==measurementId){
        dbg.dxf.measure.selectMeasurement(measurementId); await settle(1);
        session=dbg.dxf.measure.getSession();
        if(session.selectedMeasurementId!==measurementId) throw new Error('could not select measurement '+measurementId+' before endpoint drag');
      }
      const beforeValue=dbg.dxf.measure.valueInches(measurementId);
      const beforeRecomputes=session.diagnostics.dragPreviewRecomputes;
      const measurement=session.measurements.find(m=>m.id===measurementId), endpoint=measurement[which];
      const handle=dbg.dxf.measure.handleWorldPosition(measurementId,which);
      const segments=dbg.dxf.measure.pieceSegments(endpoint.pieceIndex);
      if(!handle) throw new Error('missing live handle for measurement '+measurementId+' '+which+' endpoint='+JSON.stringify(endpoint));
      let target=null,targetRef=null,targetDistance=-1;
      const candidateSegments=[...new Set([endpoint.segIndexInPiece,...measurement.route.steps.map(step=>step.segIndex)])];
      for(const segIndex of candidateSegments) for(const t of [.08,.35,.65,.92]){
        const ref={pieceIndex:endpoint.pieceIndex,segIndexInPiece:segIndex,t};
        const other=measurement[which==='a'?'b':'a'];
        const routes=dbg.dxf.measure.enumerateRoutes(which==='a'?ref:other,which==='a'?other:ref);
        if(!routes.ok)continue;
        const world=dbg.dxf.measure.nativeToBoardLive(pointOn(segments[segIndex],t),endpoint.pieceIndex);
        if(!world) continue;
        const d=Math.hypot(world.x-handle.x,world.y-handle.y)*dbg.getView().zoom;
        if(d>targetDistance){targetDistance=d;target=world;targetRef=ref;}
      }
      if(!target) throw new Error('missing drag target for measurement '+measurementId+' '+which+' route='+JSON.stringify(measurement.route));
      fireWorld('mousedown',handle);
      const downInteraction=dbg.dxf.measure.getSession().interaction;
      for(let i=1;i<=12;i+=1) fireWorld('mousemove',{x:handle.x+(target.x-handle.x)*i/12,y:handle.y+(target.y-handle.y)*i/12});
      await settle(1);
      fireWorld('mouseup',target); await settle(1);
      let pending=dbg.dxf.measure.getSession().interaction;
      if(pending && pending.type==='choosing-entity') { await resolveEntity(targetRef); pending=dbg.dxf.measure.getSession().interaction; }
      if(pending && pending.type==='choosing-route') { dbg.dxf.measure.confirmPendingChoice(); await settle(1); }
      session=dbg.dxf.measure.getSession();
      return {beforeValue,afterValue:dbg.dxf.measure.valueInches(measurementId),recomputes:session.diagnostics.dragPreviewRecomputes-beforeRecomputes,downInteraction};
    };
    const dragDirectEndpoint = async (measurementId,which) => {
      dbg.dxf.measure.selectMeasurement(measurementId); await settle(1);
      const session=dbg.dxf.measure.getSession(),beforeValue=dbg.dxf.measure.valueInches(measurementId);
      const beforeRecomputes=session.diagnostics.dragPreviewRecomputes;
      const handle=dbg.dxf.measure.handleWorldPosition(measurementId,which);
      const other=dbg.dxf.measure.handleWorldPosition(measurementId,which==='a'?'b':'a');
      const target={x:handle.x+(other.x-handle.x)*.35,y:handle.y+(other.y-handle.y)*.35};
      fireWorld('mousedown',handle); const downInteraction=dbg.dxf.measure.getSession().interaction;
      for(let i=1;i<=12;i+=1)fireWorld('mousemove',{x:handle.x+(target.x-handle.x)*i/12,y:handle.y+(target.y-handle.y)*i/12});
      await settle(1);fireWorld('mouseup',target);await settle(1);
      const after=dbg.dxf.measure.getSession();
      return {beforeValue,afterValue:dbg.dxf.measure.valueInches(measurementId),recomputes:after.diagnostics.dragPreviewRecomputes-beforeRecomputes,downInteraction};
    };
    const perPiece=[];
    for(let pieceIndex=0;pieceIndex<6;pieceIndex+=1){
      console.log('[factory-proof] piece '+pieceIndex+' start');
      const used=new Set();
      const forwardPair=findPair(pieceIndex,'forward',used);
      if(!forwardPair) throw new Error('no production forward pair for piece '+pieceIndex);
      const forward=await createAlong(forwardPair,'forward');
      console.log('[factory-proof] piece '+pieceIndex+' forward');
      forward.route.steps.forEach(step=>used.add(step.segIndex));
      const reversePair=findPair(pieceIndex,'reverse',new Set());
      if(!reversePair) throw new Error('no production reverse pair for piece '+pieceIndex);
      const reverse=await createAlong(reversePair,'reverse');
      console.log('[factory-proof] piece '+pieceIndex+' reverse');
      reverse.route.steps.forEach(step=>used.add(step.segIndex));
      const dragB=await dragEndpoint(reverse.id,'b');

      const sessionBeforeDirect=dbg.dxf.measure.getSession(), bounds=sessionBeforeDirect.pieceBounds[pieceIndex];
      const nativeA={x:bounds.x+bounds.width*.38,y:bounds.y+bounds.height*.43};
      const nativeB={x:bounds.x+bounds.width*.62,y:bounds.y+bounds.height*.57};
      document.getElementById('toolsMenuBtn').click(); document.getElementById('dxfMeasureOutBtn').click();
      await clickWorld(dbg.dxf.measure.nativeToBoardLive(nativeA,pieceIndex));
      await clickWorld(dbg.dxf.measure.nativeToBoardLive(nativeB,pieceIndex));
      const afterDirect=dbg.dxf.measure.getSession(), direct=afterDirect.measurements[afterDirect.measurements.length-1];
      if(!direct || direct.mode!=='out-of-path') throw new Error('real Out of Path action failed for piece '+pieceIndex);
      console.log('[factory-proof] piece '+pieceIndex+' direct');

      const dragA=await dragDirectEndpoint(direct.id,'a');
      console.log('[factory-proof] piece '+pieceIndex+' dragged');
      const valuesBefore=[forward.id,reverse.id,direct.id].map(id=>dbg.dxf.measure.valueInches(id));
      const directHandleBefore=dbg.dxf.measure.handleWorldPosition(direct.id,'a');
      dbg.clearSelection();
      document.getElementById('toolSelect').click();
      const anchorGeometry=dbg.dxf.measure.pieceAnchorGeometry(pieceIndex);
      const moveStart={x:(anchorGeometry.start.x+anchorGeometry.end.x)/2,y:(anchorGeometry.start.y+anchorGeometry.end.y)/2};
      const moveEnd={x:moveStart.x+24/Math.max(.1,dbg.getView().zoom),y:moveStart.y+16/Math.max(.1,dbg.getView().zoom)};
      if(!dbg.dxf.measure.beginPieceMove(pieceIndex,moveStart))throw new Error('could not begin production whole-piece move '+pieceIndex);
      fireWorld('mousemove',moveEnd); fireWorld('mouseup',moveEnd); await settle(2);
      const valuesAfter=[forward.id,reverse.id,direct.id].map(id=>dbg.dxf.measure.valueInches(id));
      const directHandleAfter=dbg.dxf.measure.handleWorldPosition(direct.id,'a');
      console.log('[factory-proof] piece '+pieceIndex+' moved');

      if(pieceIndex===0){
        dbg.dxf.measure.activateMeasurementForEdit(direct.id); await settle(1);
        const labelBefore=dbg.dxf.measure.labelWorldPosition(direct.id), valueBefore=dbg.dxf.measure.valueInches(direct.id);
        fireWorld('mousedown',labelBefore); const labelTarget={x:labelBefore.x+35/Math.max(.1,dbg.getView().zoom),y:labelBefore.y+22/Math.max(.1,dbg.getView().zoom)};
        fireWorld('mousemove',labelTarget); fireWorld('mouseup',labelTarget); await settle(1);
        const labelAfter=dbg.dxf.measure.labelWorldPosition(direct.id), valueAfter=dbg.dxf.measure.valueInches(direct.id);
        press('Delete'); await settle(1); const deleted=dbg.dxf.measure.getSession().measurementCount;
        press('z',{metaKey:true}); await settle(1); const undone=dbg.dxf.measure.getSession().measurementCount;
        press('z',{metaKey:true,shiftKey:true}); await settle(1); const redone=dbg.dxf.measure.getSession().measurementCount;
        press('z',{metaKey:true}); await settle(1);
        perPiece.push({pieceIndex,forward,reverse,direct,dragA,dragB,valuesBefore,valuesAfter,directHandleBefore,directHandleAfter,
          labelProof:{labelBefore,labelAfter,valueBefore,valueAfter,deleted,undone,redone}});
      } else perPiece.push({pieceIndex,forward,reverse,direct,dragA,dragB,valuesBefore,valuesAfter,directHandleBefore,directHandleAfter});
    }
    const finalSession=dbg.dxf.measure.getSession();
    return {
      pieceCount:finalSession.pieceCount,pieceSegmentCounts:finalSession.pieceSegmentCounts,source:finalSession.source,perPiece,
      measurementCount:finalSession.measurementCount,projectJson:JSON.stringify(dbg.exportProject()),autosave:dbg.autosave.peek()||'',
      measurementAnnIds:dbg.getMeasurementAnnIds(),parserDurationMs:finalSession.source.nativeParseDurationMs,
    };
  })()`);
  check(result.pieceCount === 6, 'real fixture: 6 pieces, got ' + result.pieceCount);
  const totalSegs = result.pieceSegmentCounts.reduce((a, b) => a + b, 0);
  check(totalSegs === 1240 && JSON.stringify(result.pieceSegmentCounts) === JSON.stringify([165,261,293,273,147,101]),
    'real fixture: measurement model keeps 1240 non-degenerate segments, got ' + totalSegs + ' ' + JSON.stringify(result.pieceSegmentCounts));
  check(result.source && result.source.rejectedGeometry && result.source.rejectedGeometry.rejectedDegenerateSegments === 12,
    'real fixture: all 12 rejected zero-length hops are explicit diagnostics, got ' + JSON.stringify(result.source));
  for (const p of result.perPiece) {
    check(p.forward && p.forward.direction === 'forward' && p.reverse && p.reverse.direction === 'reverse', 'piece '+p.pieceIndex+': real UI creates deliberate forward and reverse Along Path records');
    check(p.direct && p.direct.mode === 'out-of-path' && p.direct.a.pieceIndex === p.pieceIndex && p.direct.b.pieceIndex === p.pieceIndex, 'piece '+p.pieceIndex+': real Out of Path is attached to the intended piece');
    check(!near(p.dragA.beforeValue,p.dragA.afterValue,1e-9) && !near(p.dragB.beforeValue,p.dragB.afterValue,1e-9), 'piece '+p.pieceIndex+': dragging A and B updates exact numeric values '+JSON.stringify({dragA:p.dragA,dragB:p.dragB}));
    check(p.dragA.recomputes <= 2, 'piece '+p.pieceIndex+': 12 mousemoves collapse to at most one render-frame recomputation (plus pointer-up flush), got '+p.dragA.recomputes);
    check(p.valuesBefore.every((value,i)=>near(value,p.valuesAfter[i],1e-10)), 'piece '+p.pieceIndex+': whole-piece move leaves all native values invariant');
    check(distance2d(p.directHandleBefore,p.directHandleAfter) > 1, 'piece '+p.pieceIndex+': attached Out of Path endpoint follows whole-piece display movement '+JSON.stringify({before:p.directHandleBefore,after:p.directHandleAfter}));
  }
  check(result.measurementCount === 18, 'factory proof creates 18 real production measurements, got '+result.measurementCount);
  check(!result.projectJson.includes('dxfMeasureSession') && !result.autosave.includes('dxfMeasureSession'), 'factory measurements remain absent from Project JSON and autosave');
  check(Array.isArray(result.measurementAnnIds) && result.measurementAnnIds.length === 0, 'factory measurements never enter the POM annotation set');
  check(Number.isFinite(result.parserDurationMs) && result.parserDurationMs < 50, '3380 native parse remains within one 50ms responsiveness budget, got '+result.parserDurationMs+'ms');
  const labelProof=result.perPiece[0].labelProof;
  check(distance2d(labelProof.labelBefore,labelProof.labelAfter)>1 && near(labelProof.valueBefore,labelProof.valueAfter,1e-12), 'real label drag moves presentation without changing value');
  check(labelProof.undone===labelProof.deleted+1 && labelProof.redone===labelProof.deleted, 'real delete Undo/Redo restores and re-deletes exactly one measurement');
  console.log('PASS  section 6 (real factory UI/actions): ' + JSON.stringify(result.pieceSegmentCounts));

  // CLO accuracy gate — explicitly BLOCKED, never silently skipped or faked.
  let cloRef = null;
  try {
    const raw = await readFile(path.join(appDir, 'scripts/groundtruth/dxf-measurements/3380.dxf.json'), 'utf8');
    cloRef = JSON.parse(raw);
  } catch { /* file absent entirely is also BLOCKED, handled below */ }
  const rows = cloRef && Array.isArray(cloRef.measurements) ? cloRef.measurements : [];
  const completeRef = cloRef && cloRef.source === 'td_confirmed' && rows.length === 18
    && rows.every(row => Number.isInteger(row.pieceIndex) && row.pieceIndex >= 0 && row.pieceIndex < 6
      && (row.mode === 'along-path' || row.mode === 'out-of-path')
      && row.a && Number.isInteger(row.a.segIndexInPiece) && Number.isFinite(row.a.t)
      && row.b && Number.isInteger(row.b.segIndexInPiece) && Number.isFinite(row.b.t)
      && Number.isFinite(row.expectedInches)
      && (row.mode !== 'along-path' || (typeof row.routeSignature === 'string' && row.routeSignature.length > 0)));
  if (completeRef) {
    const comparisons = await s.eval(`(() => {
      const rows=${JSON.stringify(rows)}, dbg=window.__braAutoModeDebug;
      const nativeToInches=dbg.dxf.measure.getSession().source.unit;
      const pointOn=(seg,t)=>seg.kind==='straight'
        ? {x:seg.a.x+(seg.b.x-seg.a.x)*t,y:seg.a.y+(seg.b.y-seg.a.y)*t}
        : {x:seg.center.x+Math.cos(seg.startAngle+seg.sweep*t)*seg.radius,y:seg.center.y+Math.sin(seg.startAngle+seg.sweep*t)*seg.radius};
      const signature=route=>route.steps.map(step=>step.segIndex+':'+step.t0.toFixed(9)+':'+step.t1.toFixed(9)).join('|');
      return rows.map((row,index)=>{
        const segments=dbg.dxf.measure.pieceSegments(row.pieceIndex);
        const a=Object.assign({pieceIndex:row.pieceIndex},row.a), b=Object.assign({pieceIndex:row.pieceIndex},row.b);
        let actualInches=null, matchedSignature=null;
        if(row.mode==='out-of-path'){
          actualInches=dbg.dxf.measure.directDistance(pointOn(segments[a.segIndexInPiece],a.t),pointOn(segments[b.segIndexInPiece],b.t))*nativeToInches;
        }else{
          const result=dbg.dxf.measure.enumerateRoutes(a,b);
          const route=result.ok?result.routes.find(candidate=>signature(candidate)===row.routeSignature):null;
          if(route){actualInches=dbg.dxf.measure.routeLength(route,segments)*nativeToInches;matchedSignature=signature(route);}
        }
        return {index,pieceIndex:row.pieceIndex,mode:row.mode,direction:row.direction,expectedInches:row.expectedInches,
          actualInches,errorMm:Number.isFinite(actualInches)?Math.abs(actualInches-row.expectedInches)*25.4:null,matchedSignature};
      });
    })()`);
    check(comparisons.every(row => Number.isFinite(row.actualInches) && Number.isFinite(row.errorMm)), 'all 18 CLO rows resolve to exact native geometry: '+JSON.stringify(comparisons));
    for (const row of comparisons) check(row.errorMm <= 0.1, 'CLO row '+row.index+' exceeds 0.1mm: '+JSON.stringify(row));
    const mean = comparisons.reduce((sum,row)=>sum+row.errorMm,0)/comparisons.length;
    const max = Math.max(...comparisons.map(row=>row.errorMm));
    const perPiece = Array.from({length:6},(_,pieceIndex)=>{
      const part=comparisons.filter(row=>row.pieceIndex===pieceIndex);
      return {pieceIndex,maxMm:Math.max(...part.map(row=>row.errorMm)),meanMm:part.reduce((sum,row)=>sum+row.errorMm,0)/part.length};
    });
    console.log('PASS  CLO accuracy 18/18; max=' + max.toFixed(4) + 'mm mean=' + mean.toFixed(4) + 'mm perPiece=' + JSON.stringify(perPiece));
  } else {
    releaseBlocked = true;
    console.log('BLOCKED  dxf-measurement-check   CLO comparison — no td_confirmed reference data available for demo/DXF file/3380.dxf (see scripts/groundtruth/dxf-measurements/3380.dxf.json). Per validation.md, this is BLOCKED, not PASS.');
  }
}

// ---- CDP driver boilerplate (same pattern as scripts/dxf-import-check.mjs) --
async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
async function waitForCdp(port) {
  for (let i = 0; i < 100; i += 1) { try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch { /* retry */ } await sleep(80); }
  throw new Error('CDP did not start');
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
    else if (m.method === 'Runtime.consoleAPICalled') {
      const values = (m.params.args || []).map(arg => arg.value).filter(value => value != null);
      if (values.some(value => String(value).startsWith('[factory-proof]'))) console.log(...values);
    }
  });
  const cdp = (method, params = {}) => new Promise((r, j) => {
    const n = ++id;
    pending.set(n, m => m.error ? j(new Error(m.error.message)) : r(m.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await cdp('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    eval: evalJs,
    setViewport: async (width, height) => {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(80);
    },
    waitFor: async (q, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { try { if (await evalJs(q)) return; } catch { /* retry */ } await sleep(80); }
      throw new Error('timeout ' + q);
    },
    close: () => ws.close(),
  };
}

try { await main(); } catch (e) { process.exitCode = 1; console.error('FAIL', e.message); }
finally { for (const task of cleanup.reverse()) try { await task(); } catch { /* best effort */ } }
