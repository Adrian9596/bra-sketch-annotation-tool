#!/usr/bin/env node
// US-104: "Open DXF file" import in Sketch Focus.
//
// The story's own Validation table is large; this suite covers the
// load-bearing claims rather than every listed permutation: the DXF
// group-code/section parser (including the BOM/CRLF/trailing-newline
// normalization that has to run BEFORE the even/odd pair check, or an
// ordinary well-formed file reads as corrupt), the planarity gate, the
// malformed-entity contract, the bulge-to-arc sign convention, INSERT ->
// BLOCK resolution (translate/scale/rotate, recursive nesting, the
// undefined-block/non-uniform-scale/MINSERT/circular-reference rejections —
// the dominant real-world DXF shape, see
// docs/decisions/0067-dxf-grading-nest-import.md), piece detection
// (connectivity + containment merge + no over-merge), the three
// output caps, the exact auto-fit placement formula (reused from
// createImageRecord, not reinvented), and — driven through the REAL
// Tools-menu button / file input / pointer events, not by calling internal
// functions directly — fixed style, no Template-library write, measurement
// exclusion, multi-piece move-together with no group id merge, and the
// absence of any group-resize gesture for annotations.
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

// ---- DXF fixture builders (Node-side; plain data, no browser needed) -------

const P = (code, value) => [String(code), String(value)];
const pairsToText = (pairs) => pairs.map(p => p[0] + '\n' + p[1]).join('\n') + '\n';
const sectionBlock = (name, bodyPairs) => [P(0, 'SECTION'), P(2, name), ...bodyPairs, P(0, 'ENDSEC')];
const rawDoc = (sectionArrays) => pairsToText([...sectionArrays.flat(), P(0, 'EOF')]);
const doc = (entityArrays) => rawDoc([sectionBlock('ENTITIES', entityArrays.flat())]);

function dxfLine(x1, y1, x2, y2, extra = {}) {
  const out = [P(0, 'LINE'), P(10, x1), P(20, y1)];
  if ('z1' in extra) out.push(P(30, extra.z1));
  out.push(P(11, x2), P(21, y2));
  if ('z2' in extra) out.push(P(31, extra.z2));
  if ('thickness' in extra) out.push(P(39, extra.thickness));
  if (extra.ext) out.push(P(210, extra.ext[0]), P(220, extra.ext[1]), P(230, extra.ext[2]));
  return out;
}
function dxfArc(cx, cy, r, a0, a1, extra = {}) {
  const out = [P(0, 'ARC'), P(10, cx), P(20, cy)];
  if ('z' in extra) out.push(P(30, extra.z));
  out.push(P(40, r), P(50, a0), P(51, a1));
  if ('thickness' in extra) out.push(P(39, extra.thickness));
  if (extra.ext) out.push(P(210, extra.ext[0]), P(220, extra.ext[1]), P(230, extra.ext[2]));
  return out;
}
function dxfCircle(cx, cy, r, extra = {}) {
  const out = [P(0, 'CIRCLE'), P(10, cx), P(20, cy)];
  if ('z' in extra) out.push(P(30, extra.z));
  out.push(P(40, r));
  if ('thickness' in extra) out.push(P(39, extra.thickness));
  if (extra.ext) out.push(P(210, extra.ext[0]), P(220, extra.ext[1]), P(230, extra.ext[2]));
  return out;
}
function dxfLwpolyline(count, flags, verts, extra = {}) {
  const out = [P(0, 'LWPOLYLINE'), P(90, count), P(70, flags)];
  if ('elevation' in extra) out.push(P(38, extra.elevation));
  if ('thickness' in extra) out.push(P(39, extra.thickness));
  if (extra.ext) out.push(P(210, extra.ext[0]), P(220, extra.ext[1]), P(230, extra.ext[2]));
  for (const v of verts) {
    out.push(P(10, v[0]), P(20, v[1]));
    if (v[2]) out.push(P(42, v[2]));
  }
  return out;
}
function dxfPolyline(flags, verts, extra = {}, omitSeqend = false) {
  const out = [P(0, 'POLYLINE'), P(70, flags), P(10, 0), P(20, 0)];
  if ('elevation' in extra) out.push(P(30, extra.elevation));
  if ('thickness' in extra) out.push(P(39, extra.thickness));
  if (extra.ext) out.push(P(210, extra.ext[0]), P(220, extra.ext[1]), P(230, extra.ext[2]));
  for (const v of verts) {
    out.push(P(0, 'VERTEX'), P(10, v[0]), P(20, v[1]));
    if (v[2] !== undefined) out.push(P(30, v[2]));
    if (v[3]) out.push(P(42, v[3]));
  }
  if (!omitSeqend) out.push(P(0, 'SEQEND'));
  return out;
}
// A named BLOCK definition wrapping arbitrary entity pairs, terminated by
// ENDBLK — the real-world shape a garment-CAD DXF export uses to hold one
// pattern piece's geometry (see dxfInsert below).
function dxfBlock(name, bodyPairs) {
  return [P(0, 'BLOCK'), P(8, '0'), P(2, name), P(70, 0), P(10, 0), P(20, 0), ...bodyPairs, P(0, 'ENDBLK')];
}
function dxfInsert(name, x, y, extra = {}) {
  const out = [P(0, 'INSERT'), P(8, '0'), P(2, name), P(10, x), P(20, y)];
  if ('sx' in extra) out.push(P(41, extra.sx));
  if ('sy' in extra) out.push(P(42, extra.sy));
  if ('rot' in extra) out.push(P(50, extra.rot));
  if ('cols' in extra) out.push(P(70, extra.cols));
  if ('rows' in extra) out.push(P(71, extra.rows));
  return out;
}
const docWithBlocks = (blockArrays, entityArrays) => rawDoc([
  sectionBlock('BLOCKS', blockArrays.flat()), sectionBlock('ENTITIES', entityArrays.flat()),
]);

// A connected chain of N collinear LINE entities — one piece, N segments —
// for the per-piece output-cap boundary tests.
function dxfChain(n, spacing = 1) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(...dxfLine(i * spacing, 0, (i + 1) * spacing, 0));
  return out;
}
// N single-LINE pieces spread far enough apart that the relative
// (0.0001 x diagonal) endpoint tolerance never merges them.
function dxfScatteredPieces(n, gap = 500) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(...dxfLine(i * gap, 0, i * gap + 10, 0));
  return out;
}

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanup.push(() => new Promise(r => server.close(r)));
  const port = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'dxf-import-check-'));
  cleanup.push(() => rm(userDataDir, { recursive: true, force: true }).catch(() => {}));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--window-size=1366,900',
    `${started.baseUrl}/index.html?dxfimport=${Date.now()}`]);
  cleanup.push(() => new Promise(r => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(port);
  const s = await session(port);
  await s.waitFor('window.__braAutoModeDebug && document.getElementById("modeManualBtn")', 8000);
  await s.eval(`window.__dxfErrors=[];addEventListener('error',e=>window.__dxfErrors.push(String(e.message||e.error)))`);

  // Real board, Manual + Sketch Focus, matching where this feature actually lives.
  await s.eval(`(() => {
    document.getElementById('modeManualBtn').click();
    if (!window.__braAutoModeDebug.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
  })()`);

  const HARNESS = String.raw`
window.__DXF = (() => {
  const d = window.__braAutoModeDebug;
  const canvas = document.getElementById('boardCanvas');
  const settle = () => new Promise(r => setTimeout(r, 130));
  const toClient = (wx, wy) => {
    const v = d.getView();
    const r = canvas.getBoundingClientRect();
    return { x: wx * v.zoom + v.panX + r.left, y: wy * v.zoom + v.panY + r.top };
  };
  // mouseup is bound on window (src/ui/bindings.js), not the canvas, so the
  // gesture-ending event has to be dispatched there — mirroring every other
  // check script's drag/click harness in this repo.
  const mouse = (type, wx, wy, init) => {
    const p = toClient(wx, wy);
    const target = type === 'mouseup' ? window : canvas;
    target.dispatchEvent(new MouseEvent(type, Object.assign({
      clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
    }, init || {})));
  };
  const click = async (wx, wy, init) => { mouse('mousedown', wx, wy, init); mouse('mouseup', wx, wy, init); await settle(); };
  const drag = async (wx, wy, dx, dy, init) => {
    mouse('mousedown', wx, wy, init);
    mouse('mousemove', wx + dx / 2, wy + dy / 2, init);
    mouse('mousemove', wx + dx, wy + dy, init);
    mouse('mouseup', wx + dx, wy + dy, init);
    await settle();
  };
  const importViaRealInput = async (text) => {
    // 2026-09-03: drives the File-menu "Open project…" picker
    // (#projectFileInput, accept=".json,.dxf,application/json") — the
    // dedicated Tools-menu "Open DXF file…" button was retired (ADR 0087),
    // this is the one real entry point left for a .dxf now.
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'fixture.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40; i += 1) { await settle(); }
    return d.getState();
  };
  const solidImage = (cssColor, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = cssColor; g.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  };
  // Round 11: real-pixel assertions for the multi-select halo, reusing
  // notes-check.mjs's established world-rect -> canvas-buffer-pixel
  // technique (getImageData on the live #boardCanvas) rather than trusting
  // state alone — this is a rendering defect, and state can't see it.
  const sample = (worldRect) => {
    const v = d.getView();
    const r = canvas.getBoundingClientRect();
    const dpr = canvas.width / r.width;
    const x = Math.round((worldRect.x * v.zoom + v.panX) * dpr);
    const y = Math.round((worldRect.y * v.zoom + v.panY) * dpr);
    const w = Math.max(1, Math.round(worldRect.width * v.zoom * dpr));
    const h = Math.max(1, Math.round(worldRect.height * v.zoom * dpr));
    if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) {
      return { offscreen: true, x, y, w, h, buffer: [canvas.width, canvas.height] };
    }
    return { offscreen: false, x, y, w, h, data: Array.from(canvas.getContext('2d').getImageData(x, y, w, h).data) };
  };
  const meanColor = (worldRect) => {
    const s = sample(worldRect);
    if (s.offscreen) return { offscreen: true };
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let i = 0; i < s.data.length; i += 4) {
      r += s.data[i]; g += s.data[i + 1]; b += s.data[i + 2]; a += s.data[i + 3]; n += 1;
    }
    return { offscreen: false, r: r / n, g: g / n, b: b / n, a: a / n, n };
  };
  const countColor = (worldRect, rgb, tol, minAlpha) => {
    const s = sample(worldRect);
    if (s.offscreen) return { offscreen: true, count: 0 };
    let count = 0;
    for (let i = 0; i < s.data.length; i += 4) {
      if (Math.abs(s.data[i] - rgb[0]) <= tol && Math.abs(s.data[i + 1] - rgb[1]) <= tol
        && Math.abs(s.data[i + 2] - rgb[2]) <= tol && s.data[i + 3] >= minAlpha) count += 1;
    }
    return { offscreen: false, count, total: s.data.length / 4 };
  };
  return { d, canvas, settle, toClient, mouse, click, drag, importViaRealInput, solidImage, sample, meanColor, countColor };
})();
'ready'`;
  check(await s.eval(HARNESS) === 'ready', 'the harness failed to install');

  // ===========================================================================
  // 1. Pure parser: entity geometry, planarity gate, malformed contract, the
  //    four skip buckets, section scoping, and text normalization.
  // ===========================================================================

  const lineBasic = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLine(0, 0, 10, 0)]))})`);
  check(lineBasic.ok === true && lineBasic.pieces.length === 1 && lineBasic.pieces[0].length === 1
    && lineBasic.pieces[0][0].kind === 'straight',
    `a plain LINE must parse to one straight segment, got ${JSON.stringify(lineBasic)}`);

  const arcNormal = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfArc(0, 0, 10, 0, 90)]))})`);
  check(arcNormal.ok === true && arcNormal.pieces[0].length === 1 && arcNormal.pieces[0][0].kind === 'curve',
    `a 90deg ARC must parse to exactly one curve chunk, got ${JSON.stringify(arcNormal)}`);

  const arcWrap = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfArc(0, 0, 10, 350, 10)]))})`);
  check(arcWrap.ok === true && arcWrap.pieces[0].length === 1,
    `a 350deg->10deg ARC must be treated as a 20deg sweep (one chunk), got ${JSON.stringify(arcWrap)}`);

  const circle = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfCircle(0, 0, 5)]))})`);
  check(circle.ok === true && circle.pieces.length === 1 && circle.pieces[0].length === 4
    && circle.pieces[0].every(seg => seg.kind === 'curve'),
    `a CIRCLE must parse to exactly four curve chunks forming one piece, got ${JSON.stringify(circle)}`);

  // Bulge sign convention: opposite bulge signs on the identical chord must
  // bulge to opposite sides. Checked on the raw parsed geometry (already
  // Y-flipped, still in local drawing space) rather than the rendered
  // pixels, so the assertion is exact rather than approximate.
  const bulgePos = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLwpolyline(2, 0, [[0, 0, 1], [10, 0]])]))})`);
  const bulgeNeg = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLwpolyline(2, 0, [[0, 0, -1], [10, 0]])]))})`);
  check(bulgePos.ok === true && bulgeNeg.ok === true, 'both bulge-sign fixtures must parse');
  const bulgePosMid = bulgePos.pieces[0][0].p3;
  const bulgeNegMid = bulgeNeg.pieces[0][0].p3;
  check(Math.abs(bulgePosMid.x - 5) < 1e-6 && Math.abs(bulgePosMid.y - 5) < 1e-6,
    `bulge +1 on (0,0)->(10,0) must put the arc's midpoint at (5,5) post Y-flip, got ${JSON.stringify(bulgePosMid)}`);
  check(Math.abs(bulgeNegMid.x - 5) < 1e-6 && Math.abs(bulgeNegMid.y + 5) < 1e-6,
    `bulge -1 on the identical chord must bulge to the OPPOSITE side, (5,-5), got ${JSON.stringify(bulgeNegMid)}`);

  // Closed polyline: the closing segment (last vertex -> first) carries the
  // last vertex's own bulge.
  const closedBulge = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([
    dxfLwpolyline(3, 1, [[0, 0], [10, 0], [10, 10, 1]]),
  ]))})`);
  // bulge=1 is a semicircle (180deg), which itself chunks into two <=90deg
  // curve pieces — so the closing segment contributes 2 curve entries, not 1.
  check(closedBulge.ok === true && closedBulge.pieces[0].length === 4
    && closedBulge.pieces[0][0].kind === 'straight' && closedBulge.pieces[0][1].kind === 'straight'
    && closedBulge.pieces[0][2].kind === 'curve' && closedBulge.pieces[0][3].kind === 'curve',
    `a closed LWPOLYLINE's last-vertex bulge must curve the CLOSING segment, got ${JSON.stringify(closedBulge.pieces[0].map(s => s.kind))}`);

  // Bulge magnitude > 1 (sweep > 180deg) chunks into multiple <=90deg pieces.
  const bigBulge = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLwpolyline(2, 0, [[0, 0, 2.4142135624], [10, 0]])]))})`);
  check(bigBulge.ok === true && bigBulge.pieces[0].length === 3,
    `a 270deg bulge (2.41421...) must chunk into exactly three <=90deg pieces, got ${JSON.stringify(bigBulge)}`);

  // Legacy POLYLINE/VERTEX/SEQEND.
  const legacyPolyline = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfPolyline(0, [[0, 0], [10, 0], [10, 10]])]))})`);
  check(legacyPolyline.ok === true && legacyPolyline.pieces[0].length === 2,
    `a legacy open POLYLINE with 3 vertices must yield 2 straight segments, got ${JSON.stringify(legacyPolyline)}`);

  // POLYLINE 3D-polyline flag (bit 3, value 8) -> non-planar, never flattened.
  const polyline3d = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfPolyline(8, [[0, 0], [10, 0]])]))})`);
  check(polyline3d.ok === false && polyline3d.reason === 'empty' && polyline3d.buckets.nonPlanar === 1,
    `a 3D-polyline-flagged POLYLINE must be skipped as non-planar, got ${JSON.stringify(polyline3d)}`);

  // POLYLINE curve-fit flag (bit 1, value 2) -> unsupported fit mode, never
  // naively vertex-connected.
  const polylineFit = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfPolyline(2, [[0, 0], [10, 0]])]))})`);
  check(polylineFit.ok === false && polylineFit.buckets.unsupportedFit === 1,
    `a curve-fit POLYLINE must be skipped as unsupported-fit, got ${JSON.stringify(polylineFit)}`);

  // Elevation is the CENTER point's own Z for ARC/CIRCLE (code 30) — not a
  // nonexistent code 38, which round 1 of this story got wrong.
  const arcElevation = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfArc(0, 0, 10, 0, 90, { z: 5 })]))})`);
  check(arcElevation.ok === false && arcElevation.buckets.nonPlanar === 1,
    `an ARC with a nonzero center-point Z (code 30) must be non-planar, got ${JSON.stringify(arcElevation)}`);
  // LWPOLYLINE is the one entity where 38 IS the right code.
  const lwElevation = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLwpolyline(2, 0, [[0, 0], [10, 0]], { elevation: 5 })]))})`);
  check(lwElevation.ok === false && lwElevation.buckets.nonPlanar === 1,
    `an LWPOLYLINE with nonzero code-38 elevation must be non-planar, got ${JSON.stringify(lwElevation)}`);
  const polyElevation = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfPolyline(0, [[0, 0], [10, 0]], { elevation: 5 })]))})`);
  check(polyElevation.ok === false && polyElevation.buckets.nonPlanar === 1,
    `a POLYLINE with nonzero base-point elevation (code 30) must be non-planar, got ${JSON.stringify(polyElevation)}`);
  const thickness = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLine(0, 0, 10, 0, { thickness: 3 })]))})`);
  check(thickness.ok === false && thickness.buckets.nonPlanar === 1,
    `a LINE with nonzero thickness (code 39) must be non-planar, got ${JSON.stringify(thickness)}`);
  const extrusion = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLine(0, 0, 10, 0, { ext: [0, 1, 0] })]))})`);
  check(extrusion.ok === false && extrusion.buckets.nonPlanar === 1,
    `a LINE with a non-(0,0,1) extrusion must be non-planar, got ${JSON.stringify(extrusion)}`);

  // Malformed bucket: missing group codes, bad radius, non-finite tokens,
  // vertex-count mismatch, degenerate vertex counts.
  const lineMissingEnd = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(rawDoc([sectionBlock('ENTITIES', [P(0, 'LINE'), P(10, 0), P(20, 0)])]))})`);
  check(lineMissingEnd.ok === false && lineMissingEnd.buckets.malformed === 1,
    `a LINE missing 11/21 must be malformed, got ${JSON.stringify(lineMissingEnd)}`);
  const arcMissing50 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(rawDoc([sectionBlock('ENTITIES', [P(0, 'ARC'), P(10, 0), P(20, 0), P(40, 5), P(51, 90)])]))})`);
  check(arcMissing50.ok === false && arcMissing50.buckets.malformed === 1,
    `an ARC missing group 50 must be malformed, got ${JSON.stringify(arcMissing50)}`);
  const circleR0 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfCircle(0, 0, 0)]))})`);
  const circleRNeg = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfCircle(0, 0, -5)]))})`);
  check(circleR0.ok === false && circleR0.buckets.malformed === 1 && circleRNeg.ok === false && circleRNeg.buckets.malformed === 1,
    `CIRCLE radius 0 and -5 must both be malformed, not imported as degenerate shapes, got ${JSON.stringify([circleR0, circleRNeg])}`);
  const nonNumeric = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLine(0, 0, 'abc', 0)]))})`);
  check(nonNumeric.ok === false && nonNumeric.buckets.malformed === 1,
    `a non-numeric coordinate token must be malformed, got ${JSON.stringify(nonNumeric)}`);
  const lwMismatch = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLwpolyline(3, 0, [[0, 0], [10, 0]])]))})`);
  check(lwMismatch.ok === false && lwMismatch.buckets.malformed === 1,
    `a group-90 count mismatching the actual vertex pairs must be malformed, got ${JSON.stringify(lwMismatch)}`);
  const lwOneVertex = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLwpolyline(1, 0, [[0, 0]])]))})`);
  const lwTwoVertex = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfLwpolyline(2, 0, [[0, 0], [10, 0]])]))})`);
  check(lwOneVertex.ok === false && lwOneVertex.buckets.malformed === 1,
    `a 1-vertex LWPOLYLINE must be malformed, got ${JSON.stringify(lwOneVertex)}`);
  check(lwTwoVertex.ok === true && lwTwoVertex.pieces[0].length === 1,
    `a 2-vertex LWPOLYLINE must import as one segment, got ${JSON.stringify(lwTwoVertex)}`);

  // Section scoping: geometry sitting BARE in BLOCKS (no BLOCK/ENDBLK
  // wrapper — not real DXF, but a malformed shape worth pinning) is still
  // never entities; a POLYLINE without SEQEND and a missing ENTITIES section
  // are whole-file, not per-entity. A PROPERLY block-wrapped piece that IS
  // referenced by an INSERT is a different, now-supported case — see
  // "INSERT -> BLOCK resolution" below.
  const blocksOnly = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(rawDoc([
    sectionBlock('BLOCKS', dxfLine(0, 0, 10, 0)), sectionBlock('ENTITIES', []),
  ]))})`);
  check(blocksOnly.ok === false && blocksOnly.reason === 'empty',
    `geometry sitting bare in BLOCKS with no BLOCK wrapper and an empty ENTITIES must report "no supported entities", got ${JSON.stringify(blocksOnly)}`);
  const missingEntities = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(rawDoc([sectionBlock('HEADER', [])]))})`);
  check(missingEntities.ok === false && missingEntities.atomic === true,
    `a file with no ENTITIES section must be an atomic rejection, got ${JSON.stringify(missingEntities)}`);
  const noSeqend = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(rawDoc([sectionBlock('ENTITIES', dxfPolyline(0, [[0, 0], [10, 0]], {}, true))]))})`);
  check(noSeqend.ok === false && noSeqend.atomic === true,
    `a POLYLINE with no matching SEQEND must be an atomic rejection, got ${JSON.stringify(noSeqend)}`);
  const binary = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify('AutoCAD Binary DXF\r\n\x1a\x00garbage')})`);
  check(binary.ok === false && binary.reason === 'binary',
    `a binary-DXF sentinel must be its own distinct rejection reason, got ${JSON.stringify(binary)}`);

  // Mixed file: four distinct, correctly-attributed skip buckets, never one
  // undifferentiated count.
  const mixed = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([
    dxfLine(0, 0, 10, 0),
    [P(0, 'TEXT'), P(1, 'hi')],
    dxfLine(0, 0, 'x', 0),
    dxfPolyline(2, [[0, 0], [10, 0]]),
    dxfLine(0, 0, 20, 0, { thickness: 2 }),
  ]))})`);
  check(mixed.ok === true && mixed.pieces.flat().length === 1
    && mixed.buckets.unsupportedType === 1 && mixed.buckets.malformed === 1
    && mixed.buckets.unsupportedFit === 1 && mixed.buckets.nonPlanar === 1,
    `a mixed file must report all four skip buckets distinctly while still placing the one valid entity, got ${JSON.stringify(mixed)}`);

  // BOM / CRLF / trailing-newline normalization — the exact bug an
  // .md-only or naive parser reads as "corrupt" on an ordinary file.
  const base = doc([dxfLine(0, 0, 10, 0)]);
  const withExtraTrailingNewline = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(base + '\n')})`);
  const withCrlf = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(base.replace(/\n/g, '\r\n'))})`);
  const withBom = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify('﻿' + base)})`);
  check(withExtraTrailingNewline.ok === true && withExtraTrailingNewline.pieces[0].length === 1,
    `an extra trailing newline must not read as a corrupt/odd group-code stream, got ${JSON.stringify(withExtraTrailingNewline)}`);
  check(withCrlf.ok === true && withCrlf.pieces[0].length === 1,
    `CRLF line endings must parse identically to LF, got ${JSON.stringify(withCrlf)}`);
  check(withBom.ok === true && withBom.pieces[0].length === 1,
    `a UTF-8 BOM prefix must not corrupt the first group code, got ${JSON.stringify(withBom)}`);

  // ===========================================================================
  // 1c. INSERT -> BLOCK resolution — the real-world fix. Garment-CAD DXF
  //     exports (Gerber/Lectra/Rich-style) put every pattern piece's actual
  //     geometry inside a named BLOCK and reference it once via INSERT in
  //     ENTITIES; left unresolved, a file built this way has zero directly-
  //     supported entities and is rejected outright even though it is an
  //     ordinary, valid pattern (see docs/decisions/0067-dxf-grading-nest-import.md).
  // ===========================================================================

  const insertBasic = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('PIECE', dxfLine(0, 0, 10, 0))],
    [dxfInsert('PIECE', 100, 200)],
  ))})`);
  check(insertBasic.ok === true && insertBasic.pieces.length === 1 && insertBasic.pieces[0].length === 1
    && insertBasic.pieces[0][0].kind === 'straight',
    `a block referenced by one INSERT must resolve to that block's geometry, got ${JSON.stringify(insertBasic)}`);
  // Y-flip runs AFTER placement, so a block LINE (0,0)->(10,0) placed at
  // INSERT (100,200) lands at local (100,200)->(110,200), flipped to
  // (100,-200)->(110,-200).
  const insertSeg = insertBasic.pieces[0][0];
  check(Math.abs(insertSeg.a.x - 100) < 1e-6 && Math.abs(insertSeg.a.y + 200) < 1e-6
    && Math.abs(insertSeg.b.x - 110) < 1e-6 && Math.abs(insertSeg.b.y + 200) < 1e-6,
    `INSERT's insertion point (10/20) must translate the block's local geometry, got ${JSON.stringify(insertSeg)}`);

  // Uniform scale + rotation: a unit-length LINE along +X, INSERT scale 2,
  // rotation 90deg, at the origin -> pre-flip that's a length-2 segment along
  // local +Y; parseDxfDocument's own Y-flip (applied uniformly, after
  // placement, to every accepted segment) then puts it at -Y in the result.
  const insertTransformed = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', dxfLine(0, 0, 1, 0))],
    [dxfInsert('P', 0, 0, { sx: 2, sy: 2, rot: 90 })],
  ))})`);
  check(insertTransformed.ok === true, `a scaled+rotated INSERT must still resolve, got ${JSON.stringify(insertTransformed)}`);
  const tSeg = insertTransformed.pieces[0][0];
  check(Math.abs(tSeg.a.x) < 1e-6 && Math.abs(tSeg.a.y) < 1e-6
    && Math.abs(tSeg.b.x) < 1e-6 && Math.abs(tSeg.b.y + 2) < 1e-6,
    `INSERT scale 2 + rotation 90deg on a unit +X segment must produce a length-2 segment ending at Y-flipped (0,-2), got ${JSON.stringify(tSeg)}`);

  // Mirrored (negative-scale) INSERT: |sx| == |sy| passes the uniform-scale
  // gate, and the affine point transform reflects the geometry exactly.
  // (This claim previously lived only in dxfInsertTransformPoint's comment —
  // ADR 0073 made the native parser share the same transform, so the board
  // side now carries an executable proof too.)
  const insertMirrored = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', dxfLine(0, 0, 10, 0))],
    [dxfInsert('P', 0, 0, { sx: -1, sy: 1 })],
  ))})`);
  check(insertMirrored.ok === true, `a mirrored INSERT (sx=-1, sy=1) must resolve, got ${JSON.stringify(insertMirrored)}`);
  const mSeg = insertMirrored.pieces[0][0];
  check(Math.abs(mSeg.a.x) < 1e-6 && Math.abs(mSeg.b.x + 10) < 1e-6 && Math.abs(mSeg.b.y) < 1e-6,
    `mirroring across Y must map (10,0) to (-10,0), got ${JSON.stringify(mSeg)}`);

  // Two INSERTs of the same block at different points -> two separate
  // pieces (no accidental sharing/merging of the block's own geometry).
  const insertTwice = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', dxfLine(0, 0, 10, 0))],
    [dxfInsert('P', 0, 0), dxfInsert('P', 1000, 1000)],
  ))})`);
  check(insertTwice.ok === true && insertTwice.pieces.length === 2,
    `the same block placed by two INSERTs must yield two independent pieces, got ${JSON.stringify(insertTwice)}`);

  // Nested INSERT: block B contains an INSERT of block A — recursive
  // resolution, not just one level deep.
  const insertNested = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('A', dxfLine(0, 0, 10, 0)), dxfBlock('B', dxfInsert('A', 5, 5))],
    [dxfInsert('B', 0, 0)],
  ))})`);
  check(insertNested.ok === true && insertNested.pieces.length === 1 && insertNested.pieces[0].length === 1,
    `an INSERT-of-an-INSERT (nested block reference) must resolve recursively, got ${JSON.stringify(insertNested)}`);

  // A block containing both a supported LINE and an unsupported TEXT: the
  // LINE is placed, and the TEXT is bucketed exactly like a top-level one.
  const insertMixedBlock = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', [...dxfLine(0, 0, 10, 0), P(0, 'TEXT'), P(1, 'hi')])],
    [dxfInsert('P', 0, 0)],
  ))})`);
  check(insertMixedBlock.ok === true && insertMixedBlock.pieces.flat().length === 1
    && insertMixedBlock.buckets.unsupportedType === 1,
    `an unsupported entity inside a resolved block must still be bucketed, not silently dropped or fail the whole INSERT, got ${JSON.stringify(insertMixedBlock)}`);

  // INSERT referencing a block name that doesn't exist -> malformed, not a
  // silent no-op or a whole-file crash.
  const insertUndefined = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', dxfLine(0, 0, 10, 0))],
    [dxfInsert('GHOST', 0, 0)],
  ))})`);
  check(insertUndefined.ok === false && insertUndefined.buckets.malformed === 1,
    `an INSERT referencing an undefined block must be malformed, got ${JSON.stringify(insertUndefined)}`);

  // Non-uniform scale (sx != sy) is explicitly out of scope for v1 — rejected
  // with a stated reason, never silently distorted.
  const insertNonUniform = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', dxfLine(0, 0, 10, 0))],
    [dxfInsert('P', 0, 0, { sx: 2, sy: 1 })],
  ))})`);
  check(insertNonUniform.ok === false && insertNonUniform.buckets.unsupportedType === 1,
    `an INSERT with non-uniform scale must be skipped as unsupported, not silently distorted, got ${JSON.stringify(insertNonUniform)}`);

  // MINSERT (rectangular array via group 70/71 > 1) is explicitly out of
  // scope for v1 — rejected with a stated reason, never silently duplicated.
  const insertArray = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', dxfLine(0, 0, 10, 0))],
    [dxfInsert('P', 0, 0, { cols: 3, rows: 1 })],
  ))})`);
  check(insertArray.ok === false && insertArray.buckets.unsupportedType === 1,
    `a rectangular-array INSERT (MINSERT) must be skipped as unsupported, not silently duplicated, got ${JSON.stringify(insertArray)}`);

  // Circular BLOCK/INSERT reference must be rejected (bounded recursion),
  // never hang or crash the parse.
  const insertCircular = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('A', dxfInsert('B', 0, 0)), dxfBlock('B', dxfInsert('A', 0, 0))],
    [dxfInsert('A', 0, 0)],
  ))})`);
  check(insertCircular.ok === false,
    `a circular BLOCK/INSERT reference must be rejected (bounded recursion), not hang, got ${JSON.stringify(insertCircular)}`);

  // ---------------------------------------------------------------------------
  // ADR 0069: placement-instance boundary. A grading-nest DXF places every
  // size/piece as its own INSERT, usually all at the SAME (identity)
  // transform — their geometry routinely nests or even touches by pure
  // coincidence of shared placement, which used to fuse unrelated pieces
  // into one blob (measured on real files: a 17182-segment single "piece").
  // ---------------------------------------------------------------------------

  // Two different blocks, one's outline fully bounding-box-contains the
  // other's — must stay TWO pieces (different INSERTs), not merge the way
  // a real drill-hole/grainline inside the SAME block would.
  const square = (x0, y0, size) => [
    ...dxfLine(x0, y0, x0 + size, y0), ...dxfLine(x0 + size, y0, x0 + size, y0 + size),
    ...dxfLine(x0 + size, y0 + size, x0, y0 + size), ...dxfLine(x0, y0 + size, x0, y0),
  ];
  const insertNestedInstances = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('OUTER', square(0, 0, 100)), dxfBlock('INNER', square(10, 10, 80))],
    [dxfInsert('OUTER', 0, 0), dxfInsert('INNER', 0, 0)],
  ))})`);
  check(insertNestedInstances.ok === true && insertNestedInstances.pieces.length === 2,
    `two different blocks whose bounding boxes nest must stay two pieces, not merge like an internal mark would, got ${JSON.stringify(insertNestedInstances.ok ? insertNestedInstances.pieces.map(p => p.length) : insertNestedInstances)}`);

  // Two different blocks whose geometry TOUCHES exactly (shared endpoint,
  // by coincidence of both using identity placement) — must stay TWO
  // pieces; connectivity must not cross an instance boundary either.
  const insertTouchingInstances = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('A', dxfLine(0, 0, 10, 0)), dxfBlock('B', dxfLine(10, 0, 20, 0))],
    [dxfInsert('A', 0, 0), dxfInsert('B', 0, 0)],
  ))})`);
  check(insertTouchingInstances.ok === true && insertTouchingInstances.pieces.length === 2,
    `two different blocks whose geometry happens to share an endpoint must stay two pieces, got ${JSON.stringify(insertTouchingInstances.ok ? insertTouchingInstances.pieces.map(p => p.length) : insertTouchingInstances)}`);

  // Combines both: ONE block's own outline + internal drill hole (same
  // instance) still merge into one piece as before, while a SEPARATE
  // block's mark that happens to nest inside that same outline's bbox
  // stays its own piece.
  const insertMixedInstances = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('PIECE', [...square(0, 0, 50), ...dxfCircle(25, 25, 5)]), dxfBlock('OTHER', dxfLine(20, 20, 30, 30))],
    [dxfInsert('PIECE', 0, 0), dxfInsert('OTHER', 0, 0)],
  ))})`);
  check(insertMixedInstances.ok === true && insertMixedInstances.pieces.length === 2
    && insertMixedInstances.pieces.some(p => p.length === 4 /* square */ + 4 /* circle chunks */)
    && insertMixedInstances.pieces.some(p => p.length === 1 /* OTHER's lone line */),
    `a block's own internal mark still merges with its own outline, but a different block's mark nested in the same bbox must not, got ${JSON.stringify(insertMixedInstances.ok ? insertMixedInstances.pieces.map(p => p.length) : insertMixedInstances)}`);

  // Nested INSERT (block B = an INSERT of block A + B's own directly-placed
  // touching LINE): both must share B's single top-level instance and
  // merge into ONE piece, not be treated as "different instances" just
  // because the geometry traces back through a nested INSERT.
  const insertNestedSameInstance = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(docWithBlocks(
    [dxfBlock('A', dxfLine(0, 0, 10, 0)), dxfBlock('B', [...dxfInsert('A', 0, 0), ...dxfLine(10, 0, 20, 0)])],
    [dxfInsert('B', 0, 0)],
  ))})`);
  check(insertNestedSameInstance.ok === true && insertNestedSameInstance.pieces.length === 1 && insertNestedSameInstance.pieces[0].length === 2,
    `a nested INSERT's geometry and its containing block's own directly-placed geometry must still merge as one piece, got ${JSON.stringify(insertNestedSameInstance.ok ? insertNestedSameInstance.pieces.map(p => p.length) : insertNestedSameInstance)}`);

  // ===========================================================================
  // 2. Pure placement transform — round 11: DXF's own 85% fit ratio, and
  //    (a follow-up review's catch) the fit must be ZOOM-COMPENSATED. `rect`
  //    is screen-space but the output is world-space, which the render loop
  //    later multiplies by state.zoom — so "85% of the viewport" is only
  //    true at zoom 1 unless the formula divides the current zoom back out.
  //    Same 1000x500-bounds/1000x800-viewport fixture at zoom 0.5x/1x/2x:
  //    the on-screen size (outputWidth/outputHeight * zoom) must stay
  //    CONSTANT across all three, not just at the zoom the old test assumed.
  // ===========================================================================

  const fitZ1 = await s.eval(`window.__braAutoModeDebug.dxf.computePlacement(
    { x: 0, y: 0, width: 1000, height: 500 }, { width: 1000, height: 800 }, { x: 0, y: 0 }, 1)`);
  check(Math.abs(fitZ1.scale - 0.85) < 1e-9 && Math.abs(fitZ1.outputWidth - 850) < 1e-6 && Math.abs(fitZ1.outputHeight - 425) < 1e-6
    && Math.abs(fitZ1.originX + 425) < 1e-6 && Math.abs(fitZ1.originY + 212.5) < 1e-6,
    `at zoom 1x the 85%-viewport-fit auto-fit box must be exact, got ${JSON.stringify(fitZ1)}`);
  const fitZ2 = await s.eval(`window.__braAutoModeDebug.dxf.computePlacement(
    { x: 0, y: 0, width: 1000, height: 500 }, { width: 1000, height: 800 }, { x: 0, y: 0 }, 2)`);
  check(Math.abs(fitZ2.outputWidth - 425) < 1e-6 && Math.abs(fitZ2.outputHeight - 212.5) < 1e-6,
    `at zoom 2x the WORLD-space output must be HALF the zoom-1x size (so the on-screen size matches), got ${JSON.stringify(fitZ2)}`);
  const fitZHalf = await s.eval(`window.__braAutoModeDebug.dxf.computePlacement(
    { x: 0, y: 0, width: 1000, height: 500 }, { width: 1000, height: 800 }, { x: 0, y: 0 }, 0.5)`);
  check(Math.abs(fitZHalf.outputWidth - 1700) < 1e-6 && Math.abs(fitZHalf.outputHeight - 850) < 1e-6,
    `at zoom 0.5x the WORLD-space output must be DOUBLE the zoom-1x size, got ${JSON.stringify(fitZHalf)}`);
  for (const [label, f, z] of [['0.5x', fitZHalf, 0.5], ['1x', fitZ1, 1], ['2x', fitZ2, 2]]) {
    check(Math.abs(f.outputWidth * z - 850) < 1e-6 && Math.abs(f.outputHeight * z - 425) < 1e-6,
      `on-screen size (outputWidth/outputHeight * zoom) must be the SAME 850x425 at every zoom, got ${label} -> ${JSON.stringify({ w: f.outputWidth * z, h: f.outputHeight * z })}`);
  }
  const zoomDefaultsTo1 = await s.eval(`window.__braAutoModeDebug.dxf.computePlacement(
    { x: 0, y: 0, width: 1000, height: 500 }, { width: 1000, height: 800 }, { x: 0, y: 0 })`);
  check(Math.abs(zoomDefaultsTo1.outputWidth - fitZ1.outputWidth) < 1e-9,
    `omitting zoom must default to 1x (existing callers unaffected), got ${JSON.stringify(zoomDefaultsTo1)}`);

  // No floor anymore (round 11 dropped the old 180px floor — a "fit" that
  // forces overflow at a tiny viewport isn't a fit): a tiny drawing in a
  // tiny viewport gets the SAME 0.85 ratio-derived scale as the large
  // fixture above, not a floor-inflated one.
  const tinyViewport = await s.eval(`window.__braAutoModeDebug.dxf.computePlacement(
    { x: 0, y: 0, width: 10, height: 10 }, { width: 100, height: 100 }, { x: 0, y: 0 }, 1)`);
  check(Math.abs(tinyViewport.scale - 8.5) < 1e-9 && Math.abs(tinyViewport.outputWidth - 85) < 1e-6,
    `a tiny drawing in a tiny viewport must still use the plain 85% ratio (scale 8.5), no floor inflating it, got ${JSON.stringify(tinyViewport)}`);

  // ===========================================================================
  // 3. Piece detection: connectivity, containment merge, no over-merge.
  // ===========================================================================

  const twoDisjoint = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([
    dxfLine(0, 0, 10, 0), dxfLine(1000, 1000, 1010, 1000),
  ]))})`);
  check(twoDisjoint.ok === true && twoDisjoint.pieces.length === 2,
    `two far-apart disjoint LINEs must become two separate pieces, got ${JSON.stringify(twoDisjoint)}`);

  // Outline + a non-touching internal CIRCLE (drill hole) + a non-touching
  // internal LINE (grainline) must merge into ONE piece via the
  // containment pass, not split into three by connectivity alone.
  const containment = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([
    dxfLwpolyline(4, 1, [[0, 0], [100, 0], [100, 100], [0, 100]]),
    dxfCircle(50, 50, 5),
    dxfLine(20, 50, 30, 50),
  ]))})`);
  check(containment.ok === true && containment.pieces.length === 1 && containment.pieces[0].length === 4 + 4 + 1,
    `an outline plus a non-touching internal circle and line must merge into ONE piece (4+4+1 segments), got ${JSON.stringify(containment.pieces.map(p => p.length))}`);

  // Two components whose bounding boxes only PARTIALLY overlap must stay
  // separate pieces — the containment test must not over-merge.
  const partialOverlap = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([
    dxfLine(0, 0, 10, 10), dxfLine(5, 5, 15, 0),
  ]))})`);
  check(partialOverlap.ok === true && partialOverlap.pieces.length === 2,
    `two components whose boxes only partially overlap must remain separate pieces, got ${JSON.stringify(partialOverlap)}`);

  // ===========================================================================
  // 4. Output caps.
  // ===========================================================================

  // Per-piece cap is 2500, NOT 80 (that number is normalizeShapeStamp's own
  // Template-member cap, unrelated) — see the constant's own comment in
  // src/manual/dxf-import.js for the real production files (3380.dxf,
  // ADR 0068's 1290. Flexcamo .dxf / 2892XL-new.dxf) that forced this: real
  // garment pieces there ran up to 1914/1886 segments once INSERT->BLOCK
  // resolution could see them.
  const cap2499 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfChain(2499)]))})`);
  const cap2500 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfChain(2500)]))})`);
  const cap2501 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfChain(2501), dxfLine(-100, -100, -90, -100)]))})`);
  check(cap2499.ok === true && cap2499.pieces[0].length === 2499, `a 2499-segment piece must import fully, got ${JSON.stringify(cap2499.pieces?.map(p=>p.length))}`);
  check(cap2500.ok === true && cap2500.pieces[0].length === 2500, `an exactly-2500-segment piece must import fully, got ${JSON.stringify(cap2500.pieces?.map(p=>p.length))}`);
  check(cap2501.ok === true && cap2501.skippedOversizedPieces === 1 && cap2501.pieces.length === 1 && cap2501.pieces[0].length === 1,
    `a 2501-segment piece must be skipped while a smaller valid piece in the same file still imports, got ${JSON.stringify(cap2501)}`);

  const pieces120 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfScatteredPieces(120)]))})`);
  const pieces121 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfScatteredPieces(121)]))})`);
  check(pieces120.ok === true && pieces120.pieces.length === 120, `exactly 120 pieces must import, got ${JSON.stringify(pieces120.ok)} ${pieces120.pieces?.length}`);
  check(pieces121.ok === false && pieces121.reason === 'piece-cap', `121 pieces must be a whole-file piece-cap rejection, got ${JSON.stringify(pieces121)}`);

  // Nine 2400-segment chains, spaced far apart (9*2400=21600 > 20000
  // total, each piece under the 2500 per-piece cap, 9 pieces well under the
  // 120-piece cap).
  const nineChains = [0, 20000, 40000, 60000, 80000, 100000, 120000, 140000, 160000].flatMap(offset => {
    const segs = [];
    for (let i = 0; i < 2400; i += 1) segs.push(...dxfLine(offset + i, 0, offset + i + 1, 0));
    return segs;
  });
  const totalCap = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([nineChains]))})`);
  check(totalCap.ok === false && totalCap.reason === 'total-cap',
    `9 pieces of 2400 segments (21600 total, each under the 2500 per-piece cap, 9 under the 120-piece cap) must be rejected by the 20000 combined-output cap, got ${JSON.stringify(totalCap)}`);

  // ===========================================================================
  // 5. Integration: the REAL Tools-menu button + hidden file input + real
  //    board mutation.
  // ===========================================================================

  const stampsBefore = await s.eval(`window.__braAutoModeDebug.getShapeStamps()`);
  const measuredBefore = await s.eval(`window.__braAutoModeDebug.getMeasurementAnnIds()`);
  const realImport = await s.eval(`(async () => {
    const r = await window.__DXF.importViaRealInput(${JSON.stringify(doc([
      dxfLine(0, 0, 100, 0), dxfLine(2000, 2000, 2100, 2000),
    ]))});
    return { state: r, anns: window.__braAutoModeDebug.getAnnotations() };
  })()`);
  const importedAnns = realImport.anns.filter(a => a.purpose === 'sketch-element' && a.id >= 0);
  check(realImport.state.selection.kind === 'annotation' && realImport.state.selectedAnnotationIds.length === importedAnns.length
    && importedAnns.length === 2,
    `a real Tools-menu DXF import must place 2 annotations, all selected, got ${JSON.stringify({ sel: realImport.state.selectedAnnotationIds, n: importedAnns.length })}`);
  check(importedAnns.every(a => a.purpose === 'sketch-element' && a.style === 'solid' && a.color === 'black'
    && a.lineWidth === 2.5 && a.arrowType === 'none' && a.lineTreatment === null && !a.sourceImageId),
    `every imported annotation must carry the fixed style and no sourceImageId on an empty board, got ${JSON.stringify(importedAnns)}`);
  const groupIds = new Set(importedAnns.map(a => a.templateGroupId));
  check(groupIds.size === 2 && !groupIds.has(null) && !groupIds.has(undefined),
    `the two disjoint pieces must carry two distinct, real templateGroupIds, got ${JSON.stringify([...groupIds])}`);

  // A piece landing ON a board image DOES get a sourceImageId (the same
  // Scratch Area semantics every other sketch-element source already has) —
  // both halves need proving, not just the empty-board absence above.
  const overImage = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    await d.addBoardImages([h.solidImage('#8888ff', 200, 200)]);
    const image = d.getImages()[0];
    return { image, tinyLineAnn: await (async () => {
      await h.importViaRealInput(${JSON.stringify(doc([dxfLine(0, 0, 5, 0)]))});
      return d.getAnnotations()[d.getAnnotations().length - 1];
    })() };
  })()`);
  // The tiny fixture above lands centered on the (also centered) viewport,
  // same as the image itself — reproducing the exact "first sketch on an
  // empty board" placement both this feature and createImageRecord share.
  check(!!overImage.tinyLineAnn.sourceImageId && overImage.tinyLineAnn.sourceImageId === overImage.image.id,
    `a piece placed over a board image must carry that image's id as sourceImageId, got ${JSON.stringify(overImage)}`);

  const stampsAfter = await s.eval(`window.__braAutoModeDebug.getShapeStamps()`);
  check(JSON.stringify(stampsBefore) === JSON.stringify(stampsAfter),
    'a DXF import must never write to the Template library');
  const measuredAfter = await s.eval(`window.__braAutoModeDebug.getMeasurementAnnIds()`);
  const newlyMeasured = importedAnns.filter(a => measuredAfter.includes(a.id));
  check(newlyMeasured.length === 0 && measuredAfter.length === (measuredBefore ? measuredBefore.length : 0),
    `imported sketch-element geometry must never enter the measurement set, got ${JSON.stringify({ newlyMeasured, measuredBefore, measuredAfter })}`);

  // Whole-file rejection must leave the board byte-for-byte unchanged.
  // `savedAt` is excluded — it is a fresh timestamp on every export, not
  // board content.
  const snapshotForCompare = `(() => {
    const { savedAt, ...rest } = window.__braAutoModeDebug.exportProject();
    return JSON.stringify(rest);
  })()`;
  const snapBefore = await s.eval(snapshotForCompare);
  await s.eval(`window.__DXF.importViaRealInput(${JSON.stringify('not a dxf file at all')})`);
  const snapAfter = await s.eval(snapshotForCompare);
  check(snapBefore === snapAfter, 'a corrupt-file rejection must leave the board completely unchanged');

  // Partial success: a mixed file still places its valid entity.
  const beforeCount = (await s.eval(`window.__braAutoModeDebug.getAnnotations()`)).length;
  await s.eval(`window.__DXF.importViaRealInput(${JSON.stringify(doc([dxfLine(3000, 3000, 3010, 3000), [P(0, 'TEXT'), P(1, 'x')]]))})`);
  const afterCount = (await s.eval(`window.__braAutoModeDebug.getAnnotations()`)).length;
  check(afterCount === beforeCount + 1, `a mixed valid/unsupported file must still place the valid entity, got ${beforeCount} -> ${afterCount}`);

  // ===========================================================================
  // 6. Multi-piece move-together, no group id merge, no group-resize gesture.
  // ===========================================================================

  await s.eval(`(async () => {
    // Fresh board for a clean geometric check. Loading a snapshot with no
    // annotations/graphics/notes boots the app into AUTO mode (ADR 0008,
    // Auto-first) regardless of what mode it was saved in — switch back to
    // Manual + Sketch Focus explicitly, or every pointer gesture below runs
    // through the Auto-mode branch of onMouseDown instead.
    await window.__braAutoModeDebug.loadProject(await (async () => {
      const p = window.__braAutoModeDebug.exportProject();
      p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!window.__braAutoModeDebug.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
  })()`);
  const twoPieceImport = await s.eval(`(async () => {
    await window.__DXF.importViaRealInput(${JSON.stringify(doc([
      dxfLine(0, 0, 100, 0), dxfLine(1000, 1000, 1100, 1000),
    ]))});
    return window.__braAutoModeDebug.getAnnotations();
  })()`);
  check(twoPieceImport.length === 2, `precondition: a clean two-piece import must yield exactly 2 annotations, got ${twoPieceImport.length}`);
  const [pieceA, pieceB] = twoPieceImport;
  const midA = { x: (pieceA.start.x + pieceA.end.x) / 2, y: (pieceA.start.y + pieceA.end.y) / 2 };
  const midB = { x: (pieceB.start.x + pieceB.end.x) / 2, y: (pieceB.start.y + pieceB.end.y) / 2 };

  const moveResult = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    await h.click(-9999, -9999); // deselect everything first
    await h.click(${midA.x}, ${midA.y});
    const afterA = d.getState().selectedAnnotationIds.slice();
    await h.click(${midB.x}, ${midB.y}, { shiftKey: true });
    const afterShift = d.getState().selectedAnnotationIds.slice();
    const before = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end, group: a.templateGroupId }));
    await h.drag(${midA.x}, ${midA.y}, 40, -25);
    const after = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end, group: a.templateGroupId }));
    return { afterA, afterShift, before, after };
  })()`);
  check(moveResult.afterA.length === 1, `a plain click on one piece must select just that piece, got ${JSON.stringify(moveResult.afterA)}`);
  check(moveResult.afterShift.length === 2, `Shift-click on the second piece must add it to the selection, got ${JSON.stringify(moveResult.afterShift)}`);
  for (const b of moveResult.before) {
    const a = moveResult.after.find(x => x.id === b.id);
    check(Math.abs((a.start.x - b.start.x) - 40) < 0.5 && Math.abs((a.start.y - b.start.y) + 25) < 0.5,
      `every selected annotation across both pieces must move by the exact same delta, id=${b.id} moved by (${a.start.x - b.start.x}, ${a.start.y - b.start.y})`);
    check(a.group === b.group, `dragging a multi-piece selection must never merge or reassign templateGroupId, id=${b.id}`);
  }
  check(moveResult.before[0].group !== moveResult.before[1].group,
    'precondition: the two pieces must have started with two distinct group ids');

  // No group-resize gesture exists for annotations: a press-and-drag near the
  // selection's bounding-box corner (empty space, not on any line) must
  // leave every annotation's geometry byte-identical — proving it is a
  // no-op or a marquee, never a scale.
  const noResize = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    const before = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end }));
    const xs = before.flatMap(a => [a.start.x, a.end.x]), ys = before.flatMap(a => [a.start.y, a.end.y]);
    const corner = { x: Math.max(...xs) + 20, y: Math.max(...ys) + 20 };
    await h.drag(corner.x, corner.y, 60, 60);
    const interactionType = d.getInteraction() ? d.getInteraction().type : null;
    const after = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end }));
    return { before, after, interactionType };
  })()`);
  check(noResize.interactionType !== 'drag-images-resize',
    `a corner-area drag over an annotation selection must never start the (images-only) resize interaction, got ${noResize.interactionType}`);
  for (const b of noResize.before) {
    const a = noResize.after.find(x => x.id === b.id);
    check(JSON.stringify(a) === JSON.stringify(b),
      `a corner-area drag outside any line must leave annotation geometry untouched (no group-resize exists), id=${b.id}`);
  }

  // ===========================================================================
  // 7. Quick length readout ("Smart Measurement").
  // ===========================================================================

  // Outline + internal circle (drill hole) + internal line (grainline), all
  // one piece via the containment merge — proves the sum is "total selected
  // path length", not the outline's own perimeter.
  const readout = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    // See the previous section's comment: an empty-board reset boots Auto
    // mode (ADR 0008) and has to be switched back explicitly.
    await window.__braAutoModeDebug.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await h.importViaRealInput(${JSON.stringify(doc([
      dxfLwpolyline(4, 1, [[0, 0], [100, 0], [100, 100], [0, 100]]),
      dxfCircle(50, 50, 5),
      dxfLine(20, 50, 30, 50),
    ]))});
    const anns = d.getAnnotations();
    // click well clear of any line first, then a point ON the outline's
    // bottom edge, to get a REAL mousedown/mouseup selection rather than
    // calling selectAnnotation().
    await h.click(-9999, -9999);
    const outlineEdge = anns.find(a => a.type === 'straight' && Math.abs(a.start.y - a.end.y) < 1e-6
      && Math.abs(a.end.x - a.start.x) > 1);
    const midPiece = { x: (outlineEdge.start.x + outlineEdge.end.x) / 2, y: outlineEdge.start.y };
    await h.click(midPiece.x, midPiece.y);
    const uncalibratedText = document.getElementById('toolStatus').innerHTML;
    // Hand-computed expected total from the REAL (already viewport-scaled)
    // annotation geometry, straight chord distance for straight segments and
    // a 1000-sample cubic-Bezier polyline length for curved ones — an
    // independent ground truth, not a re-run of the code under test. The sum
    // is strictly greater than the outline's own 4-sided perimeter, which is
    // exactly the "not just perimeter" claim this section proves.
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const bezierPoint = (p0, p1, p2, p3, t) => {
      const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
      return { x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y };
    };
    const curveLength = (ann, samples) => {
      let prev = ann.start, total = 0;
      for (let i = 1; i <= samples; i += 1) {
        const next = bezierPoint(ann.start, ann.control1, ann.control2, ann.end, i / samples);
        total += dist(prev, next);
        prev = next;
      }
      return total;
    };
    const segLength = (a) => a.type === 'straight' ? dist(a.start, a.end) : curveLength(a, 1000);
    const expectedTotalPx = anns.reduce((sum, a) => sum + segLength(a), 0);
    // The 4 square-edge segments only (each ~100 DXF units, scaled) — the
    // 10-unit grainline is a straight segment too, but far shorter, so a
    // length floor isolates just the outline without hand-picking ids.
    const outlinePerimeterPx = anns.filter(a => a.type === 'straight' && segLength(a) > 50)
      .reduce((sum, a) => sum + segLength(a), 0);

    // Round 6: the readout is now a dedicated .sketch-length-chip, a flex
    // sibling of the ellipsis-truncated sentence — prove that with a REAL
    // bounding box / visibility check, not another innerText/innerHTML
    // substring match (a chip could sit in the DOM with markup intact while
    // CSS collapses it to zero size, and no innerText assertion would ever
    // catch that).
    const chipEl = document.querySelector('#toolStatus .sketch-length-chip');
    const naturalRect = chipEl.getBoundingClientRect();
    const naturalVisible = naturalRect.width > 0 && naturalRect.height > 0 && chipEl.offsetParent !== null;
    const chipIsDirectChild = chipEl.parentElement === document.getElementById('toolStatus');
    // Force the sentence to genuinely overflow (squeeze the status bar to
    // 60px) and re-measure the chip's real box afterward — this is exactly
    // the failure mode being fixed: a long Tool sentence used to eat the
    // length text via text-overflow:ellipsis because both lived in the same
    // truncated span.
    const toolStatusEl = document.getElementById('toolStatus');
    const prevWidth = toolStatusEl.style.width, prevMaxWidth = toolStatusEl.style.maxWidth;
    toolStatusEl.style.width = '60px';
    toolStatusEl.style.maxWidth = '60px';
    const squeezedRect = chipEl.getBoundingClientRect();
    const squeezedVisible = squeezedRect.width > 0 && squeezedRect.height > 0 && chipEl.offsetParent !== null;
    toolStatusEl.style.width = prevWidth;
    toolStatusEl.style.maxWidth = prevMaxWidth;

    return {
      selection: d.getState().selectedAnnotationIds, uncalibratedText, expectedTotalPx, outlinePerimeterPx, annCount: anns.length,
      naturalVisible, chipIsDirectChild, squeezedVisible, squeezedRectWidth: squeezedRect.width,
    };
  })()`);
  check(readout.annCount === 9, `outline(4) + circle(4 chunks) + grainline(1) must be 9 annotations, got ${readout.annCount}`);
  check(readout.selection.length === 9, `clicking the outline of this piece must select the whole 9-annotation group, got ${JSON.stringify(readout.selection)}`);
  const expectedRounded = Math.round(readout.expectedTotalPx);
  check(readout.uncalibratedText.includes(expectedRounded + ' px') && /uncalibrated/i.test(readout.uncalibratedText),
    `the status line must show the uncalibrated total length (hand-computed ${expectedRounded}px from the real, scaled geometry) with an "(uncalibrated)" note, got ${JSON.stringify(readout.uncalibratedText)}`);
  check(readout.expectedTotalPx > readout.outlinePerimeterPx + 1,
    `the readout must sum MORE than the outline's own perimeter — it includes the internal circle and grainline, got total=${readout.expectedTotalPx} vs outline-only=${readout.outlinePerimeterPx}`);
  check(readout.naturalVisible,
    'the length chip must have a real, nonzero bounding box and a non-null offsetParent, not just be present in innerHTML');
  check(readout.chipIsDirectChild,
    'the length chip must be a direct sibling of the tool-status sentence inside #toolStatus, not nested inside its ellipsis-truncated span');
  check(readout.squeezedVisible && readout.squeezedRectWidth > 0,
    `even with #toolStatus squeezed to 60px (forcing the sentence to genuinely ellipsis), the length chip must keep a real, nonzero bounding box, got width=${readout.squeezedRectWidth}`);

  // Section 8 (Tools-menu "Open DXF file…" button visibility + its Command
  // Palette entry, gated to Sketch Focus) was retired 2026-09-03, ADR 0087 —
  // that button and command no longer exist. "Open project…" (exercised
  // below and in dxf-measurement-check.mjs) is the one entry point left and
  // is NOT Sketch-Focus-gated (it drives the mode switch itself), so there
  // is nothing analogous left to assert here.

  // ===========================================================================
  // 9. Real production file (private repo only — demo/DXF file/3380.dxf is
  //    excluded from the public mirror, like every demo/* fixture, so this
  //    section skips gracefully rather than failing when it is absent). The
  //    round-5 regression this story's cap numbers (80->1000 per piece,
  //    200->3000 combined) were revised against: a real factory pattern
  //    with individual pieces up to 295 segments.
  // ===========================================================================

  const realFile = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    const res = await fetch('/demo/DXF%20file/3380.dxf');
    if (!res.ok) return { skipped: true };
    const text = await res.text();
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await h.importViaRealInput(text);
    return {
      skipped: false,
      annotationCount: d.getAnnotations().length,
      groupCount: new Set(d.getAnnotations().map(a => a.templateGroupId)).size,
    };
  })()`);
  if (realFile.skipped) {
    console.log('SKIP  dxf-import-check   demo/DXF file/3380.dxf not present (public mirror) — section 9 skipped');
  } else {
    check(realFile.annotationCount === 1252 && realFile.groupCount === 6,
      `the real production file must import as 6 pieces / 1252 lines end to end, got ${JSON.stringify(realFile)}`);
  }

  // ===========================================================================
  // 10. "Open project…" (File menu) now also accepts a DXF file, dispatched
  //     by extension first and by content when the file name carries none —
  //     the SAME picker already used for saved .json projects. Also covers
  //     picking a DXF from a genuinely fresh Auto-Mode load (ADR 0008: an
  //     empty snapshot boots Auto): the switch to Manual + Sketch Focus must
  //     happen automatically, since this picker is reachable well before a TD
  //     would ever open Sketch Focus by hand. The Tools-menu "Open DXF
  //     file…" button (section 8 above) is unchanged and still
  //     Sketch-Focus-only; this is a second, independent entry point onto
  //     the SAME importDxfText engine.
  //     NOT covered here: choosing a DXF from Auto Mode while UNAPPLIED
  //     drafts are on the board (the exit-dialog branch) — that dialog logic
  //     is identical to the existing requestAppModeChange / "Open project"
  //     draft-dialog handling already exercised by hand-testing and by the
  //     Auto Mode suites; adding a duplicate CDP-driven dialog test here
  //     would not add coverage of anything specific to the DXF dispatch.
  // ===========================================================================

  const openProjectDispatch = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise(r => setTimeout(r, 40)); };
    const chooseViaOpenProject = async (name, text) => {
      document.getElementById('fileMenuBtn').click();
      const input = document.getElementById('projectFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
    };
    const resetToFreshAutoLoad = async () => {
      const p = d.exportProject();
      p.state.annotations = [];
      p.state.images = [];
      p.state.graphics = [];
      p.state.notes = [];
      await d.loadProject(p);
    };

    await resetToFreshAutoLoad();
    const beforeA = d.getState();
    await chooseViaOpenProject('fixture-a.dxf', ${JSON.stringify(doc([dxfChain(3)]))});
    const afterA = { state: d.getState(), anns: d.getAnnotations() };
    const exportedFromA = d.exportProject();

    await resetToFreshAutoLoad();
    const afterReset = d.getState();
    await chooseViaOpenProject('mystery-file', ${JSON.stringify(doc([dxfChain(2)]))});
    const afterExtensionlessDxf = { state: d.getState(), anns: d.getAnnotations() };

    // Reset first: the JSON-content-sniff branch goes through the SAME
    // "replace the board?" guard as a named .json file, and this suite has
    // no CDP dialog handler installed for window.confirm — leaving the two
    // DXF annotations above on the board would hit that guard and hang.
    await resetToFreshAutoLoad();
    await chooseViaOpenProject('mystery-file-2', JSON.stringify(exportedFromA));
    const afterExtensionlessJson = { state: d.getState(), anns: d.getAnnotations() };

    return {
      beforeA, afterA, afterReset, afterExtensionlessDxf, afterExtensionlessJson,
      exportedIds: exportedFromA.state.annotations.map(a => a.id),
    };
  })()`);

  check(openProjectDispatch.beforeA.appMode === 'auto' && openProjectDispatch.beforeA.sketchMode === false,
    `resetToFreshAutoLoad must reproduce a genuine fresh-load state (Auto, POM Focus), got ${JSON.stringify(openProjectDispatch.beforeA)}`);
  check(openProjectDispatch.afterA.state.appMode === 'manual' && openProjectDispatch.afterA.state.sketchMode === true,
    `choosing a .dxf via Open Project from a fresh Auto-Mode load must switch to Manual + Sketch Focus, got ${JSON.stringify(openProjectDispatch.afterA.state)}`);
  check(openProjectDispatch.afterA.anns.length === 3 && openProjectDispatch.afterA.anns.every(a => a.purpose === 'sketch-element'),
    `Open Project must import the DXF's 3 segments as sketch-element annotations, got ${JSON.stringify(openProjectDispatch.afterA.anns.map(a => a.purpose))}`);

  check(openProjectDispatch.afterReset.appMode === 'auto',
    `the second resetToFreshAutoLoad must also land back in Auto Mode, got ${JSON.stringify(openProjectDispatch.afterReset)}`);
  check(openProjectDispatch.afterExtensionlessDxf.state.appMode === 'manual' && openProjectDispatch.afterExtensionlessDxf.state.sketchMode === true
    && openProjectDispatch.afterExtensionlessDxf.anns.length === 2,
    `a file with no recognized extension but DXF content must still route to the DXF importer (content sniff), got ${JSON.stringify(openProjectDispatch.afterExtensionlessDxf)}`);

  check(openProjectDispatch.afterExtensionlessJson.anns.length === openProjectDispatch.exportedIds.length
    && openProjectDispatch.exportedIds.every(id => openProjectDispatch.afterExtensionlessJson.anns.some(a => a.id === id)),
    `a file with no recognized extension but JSON project content must load as a project, not get misrouted to the DXF importer, got ${JSON.stringify({ anns: openProjectDispatch.afterExtensionlessJson.anns.map(a => a.id), expected: openProjectDispatch.exportedIds })}`);

  // ===========================================================================
  // 11. "Set Scale" is now reachable from Sketch Focus itself (round 8): the
  //     More menu that houses the original #setScaleBtn/#clearScaleBtn is
  //     Sketch-Focus-hidden wholesale (.pom-mode-only on #moreMenuWrap), so a
  //     TD who just imported a DXF had no VISIBLE way to calibrate it without
  //     leaving Sketch Focus first (the Command Palette route existed but is
  //     easy to miss). #sketchSetScaleBtn / #sketchClearScaleBtn are a
  //     second, Sketch-Focus-visible entry point wired to the exact same
  //     setScaleFromSelection()/clearScale() handlers — this section drives
  //     the real dialog end to end (typed input, real button clicks), not a
  //     direct call into the calibration function.
  // ===========================================================================

  const setScaleInSketch = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, h = window.__DXF;
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await h.importViaRealInput(${JSON.stringify(doc([dxfLine(0, 0, 100, 0)]))});
    // Click at the REAL placed geometry, not the raw DXF units — the auto-fit
    // placement transform re-centers and rescales everything to the
    // viewport, so (0,0)-(100,0) in the file is not (0,0)-(100,0) on the
    // board (the exact mistake this suite's own multi-piece test above
    // avoids by reading the annotation's actual start/end back).
    const line = d.getAnnotations()[0];
    const mid = { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 };
    // A fresh import auto-selects its own new piece (importDxfText sets
    // state.selection to the newly imported ids) — deselect explicitly first
    // so "before select" actually means nothing selected.
    await h.click(-9999, -9999);

    document.getElementById('toolsMenuBtn').click(); // open the Tools menu — offsetParent is null while it's closed
    const beforeSelect = {
      setBtnVisible: document.getElementById('sketchSetScaleBtn').offsetParent !== null,
      setBtnDisabled: document.getElementById('sketchSetScaleBtn').disabled,
      clearBtnDisabled: document.getElementById('sketchClearScaleBtn').disabled,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await h.click(mid.x, mid.y); // select the single imported line
    const afterSelect = {
      setBtnDisabled: document.getElementById('sketchSetScaleBtn').disabled,
    };

    // Open, then Cancel: calibration must stay untouched.
    document.getElementById('sketchSetScaleBtn').click();
    const dialogOpenedOnCancel = !!document.querySelector('.scale-body');
    // Scope button lookup to the dialog panel itself and match by exact text
    // — the Measurements panel has its OWN permanent "+ Add POM" button that
    // also carries the shared .picker-btn class, so a bare
    // ".picker-btn:not(.primary)" query can match that instead of Cancel.
    const dialogButtons = () => Array.from(document.querySelector('.scale-body').closest('.picker-panel').querySelectorAll('.picker-btn'));
    dialogButtons().find(b => b.textContent.trim() === 'Cancel').click();
    const afterCancel = { unitsPerPx: d.getState().calibration.unitsPerPx, dialogClosed: !document.querySelector('.scale-body') };

    // Open again, type a real length, Set scale.
    document.getElementById('sketchSetScaleBtn').click();
    const input = document.querySelector('.scale-body input');
    const select = document.querySelector('.scale-body select');
    input.value = '10';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    select.value = 'in';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    dialogButtons().find(b => b.textContent.trim() === 'Set scale').click();
    const afterApply = { calibration: d.getState().calibration, clearBtnDisabled: document.getElementById('sketchClearScaleBtn').disabled };

    document.getElementById('sketchClearScaleBtn').click();
    const afterClear = { unitsPerPx: d.getState().calibration.unitsPerPx };

    // POM Focus must hide both — the original More-menu pair already covers it there.
    document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    const inPomFocus = {
      setBtnVisible: document.getElementById('sketchSetScaleBtn').offsetParent !== null,
      clearBtnVisible: document.getElementById('sketchClearScaleBtn').offsetParent !== null,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('sketchFocusBtn').click(); // back to Sketch Focus

    // The rendered line's pixel length after the auto-fit placement
    // transform (NOT the 100 DXF units in the fixture) is what "10 in" was
    // actually calibrated against.
    const linePx = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);

    return { beforeSelect, afterSelect, dialogOpenedOnCancel, afterCancel, afterApply, afterClear, inPomFocus, linePx };
  })()`);

  check(setScaleInSketch.beforeSelect.setBtnVisible === true,
    `"Set Scale…" must be visible in the Tools menu in Sketch Focus, got ${JSON.stringify(setScaleInSketch.beforeSelect)}`);
  check(setScaleInSketch.beforeSelect.setBtnDisabled === true && setScaleInSketch.beforeSelect.clearBtnDisabled === true,
    `with nothing selected and no calibration set, both buttons must start disabled, got ${JSON.stringify(setScaleInSketch.beforeSelect)}`);
  check(setScaleInSketch.afterSelect.setBtnDisabled === false,
    'selecting a line must enable "Set Scale…" in Sketch Focus');
  check(setScaleInSketch.dialogOpenedOnCancel === true, 'clicking "Set Scale…" must open the real scale dialog (.scale-body)');
  check(setScaleInSketch.afterCancel.unitsPerPx == null && setScaleInSketch.afterCancel.dialogClosed === true,
    `Cancel must close the dialog and leave calibration untouched, got ${JSON.stringify(setScaleInSketch.afterCancel)}`);
  const expectedUnitsPerPx = 10 / setScaleInSketch.linePx;
  check(setScaleInSketch.afterApply.calibration.unit === 'in'
    && Math.abs(setScaleInSketch.afterApply.calibration.unitsPerPx - expectedUnitsPerPx) < 1e-9,
    `typing "10 in" for the real (auto-fit-scaled) line and clicking "Set scale" must set unitsPerPx=10/${setScaleInSketch.linePx}=${expectedUnitsPerPx}, got ${JSON.stringify(setScaleInSketch.afterApply.calibration)}`);
  check(setScaleInSketch.afterApply.clearBtnDisabled === false, '"Clear Scale" must enable once a scale is set');
  check(setScaleInSketch.afterClear.unitsPerPx == null, '"Clear Scale" must clear the calibration');
  check(setScaleInSketch.inPomFocus.setBtnVisible === false && setScaleInSketch.inPomFocus.clearBtnVisible === false,
    `the Sketch-Focus Set/Clear Scale pair must be hidden in POM Focus (the More-menu originals cover it there), got ${JSON.stringify(setScaleInSketch.inPomFocus)}`);

  // ===========================================================================
  // 12. Round 9 (Codex follow-up): Set Scale must require exactly ONE segment,
  //     not merely "something selected". Section 11's fixture was a single
  //     LINE — one segment IS one piece IS never a group, so that distinction
  //     could never surface there. A real multi-segment piece (dxfChain, one
  //     templateGroupId, several members) is selected AS A GROUP the instant
  //     it lands (importDxfText sets state.selectedAnnotationIds to the whole
  //     batch) — getSelectedAnnotation() only ever reads the primary, so
  //     calibrating straight off it would silently target just the first
  //     segment while every segment looks selected. This drives the disable
  //     gate, the Command Palette `when` guard (bypassing the disabled DOM
  //     button entirely), the double-click isolation gesture the Template
  //     system already teaches, and the dialog's own highlight + pixel-length
  //     copy (round 9 items 1 and 2) against the ISOLATED segment, not the
  //     piece total.
  // ===========================================================================

  const soloScale = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, h = window.__DXF;
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();

    await h.importViaRealInput(${JSON.stringify(doc([dxfChain(3, 100)]))});
    const anns = d.getAnnotations();
    const groupIds = [...new Set(anns.map(a => a.templateGroupId))];

    // .disabled/.title are plain DOM properties readable whether or not the
    // Tools dropdown is open — no need to open it (and no Escape keydown,
    // which is ALSO the board's clear-selection shortcut and would wipe the
    // very selection this test is about to isolate).
    const rightAfterImport = {
      annCount: anns.length,
      groupCount: groupIds.length,
      selectedIds: d.getState().selectedAnnotationIds.length,
      setBtnDisabled: document.getElementById('sketchSetScaleBtn').disabled,
      setBtnTitle: document.getElementById('sketchSetScaleBtn').title,
      paletteReason: d.commands.list().find(c => c.id === 'board.scale.set').availability,
    };

    // Bypassing the disabled DOM button entirely: the command's own \`when\`
    // guard must still refuse a group selection and never open the dialog.
    const ranWhileGroupSelected = d.commands.run('board.scale.set');
    const dialogOpenedWhileGroupSelected = !!document.querySelector('.scale-body');

    // Double-click the MIDDLE segment (not an end one, so a wrong tolerance
    // couldn't accidentally hit a neighbor) to isolate it from the group —
    // the same enterTemplateGroupForAnnotation gesture the Template/Shape
    // -stamp system already teaches (viewport.js's onDoubleClick).
    const middle = anns[1];
    const mid = { x: (middle.start.x + middle.end.x) / 2, y: (middle.start.y + middle.end.y) / 2 };
    h.mouse('mousedown', mid.x, mid.y);
    h.mouse('mouseup', mid.x, mid.y);
    h.mouse('dblclick', mid.x, mid.y);
    await h.settle();

    const afterIsolate = {
      selectedIds: d.getState().selectedAnnotationIds.length,
      selectionId: d.getState().selection.id,
      setBtnDisabled: document.getElementById('sketchSetScaleBtn').disabled,
    };

    document.getElementById('sketchSetScaleBtn').click();
    const leadText = document.querySelector('.scale-lead') ? document.querySelector('.scale-lead').textContent : null;
    const dialogButtons = () => Array.from(document.querySelector('.scale-body').closest('.picker-panel').querySelectorAll('.picker-btn'));
    dialogButtons().find(b => b.textContent.trim() === 'Cancel').click();

    const middlePx = Math.hypot(middle.end.x - middle.start.x, middle.end.y - middle.start.y);

    return { rightAfterImport, ranWhileGroupSelected, dialogOpenedWhileGroupSelected, middleId: middle.id, afterIsolate, leadText, middlePx };
  })()`);

  check(soloScale.rightAfterImport.annCount === 3 && soloScale.rightAfterImport.groupCount === 1,
    `fixture sanity: dxfChain(3) must import as 3 segments sharing ONE templateGroupId, got ${JSON.stringify(soloScale.rightAfterImport)}`);
  check(soloScale.rightAfterImport.selectedIds === 3,
    `a fresh multi-segment import must leave the WHOLE piece selected as a group, got ${soloScale.rightAfterImport.selectedIds}`);
  check(soloScale.rightAfterImport.setBtnDisabled === true,
    'Set Scale must stay disabled while a multi-segment group is selected, not just when nothing is selected');
  check(/double-click/i.test(soloScale.rightAfterImport.setBtnTitle),
    `the disabled button's title must guide the TD to double-click a segment, got ${JSON.stringify(soloScale.rightAfterImport.setBtnTitle)}`);
  check(soloScale.rightAfterImport.paletteReason.enabled === false && /double-click/i.test(soloScale.rightAfterImport.paletteReason.reason),
    `the Command Palette entry must also refuse a group selection with the same guidance, got ${JSON.stringify(soloScale.rightAfterImport.paletteReason)}`);
  check(soloScale.ranWhileGroupSelected === false && soloScale.dialogOpenedWhileGroupSelected === false,
    'running board.scale.set directly (bypassing the disabled DOM button) must still refuse a group selection and never open the dialog');
  check(soloScale.afterIsolate.selectedIds === 1 && soloScale.afterIsolate.selectionId === soloScale.middleId,
    `double-clicking one segment must isolate it to a solo selection matching that exact segment, got ${JSON.stringify(soloScale.afterIsolate)} vs expected id ${soloScale.middleId}`);
  check(soloScale.afterIsolate.setBtnDisabled === false,
    'isolating one segment via double-click must enable Set Scale');
  const expectedMiddlePxText = String(Math.round(soloScale.middlePx));
  check(typeof soloScale.leadText === 'string' && soloScale.leadText.includes(expectedMiddlePxText + ' px'),
    `the dialog must show the ISOLATED segment's own pixel length (${expectedMiddlePxText} px), not the 3-segment piece total, got ${JSON.stringify(soloScale.leadText)}`);
  check(typeof soloScale.leadText === 'string' && soloScale.leadText.includes('highlighted'),
    `the dialog copy must call out that the segment is highlighted on the board, got ${JSON.stringify(soloScale.leadText)}`);

  // ===========================================================================
  // 13. Round 11 (user-reported, then a follow-up review caught a real
  //     alpha-stacking bug in the first fix): the multi-select group marker
  //     used to be two small circles (drawHandle) per selected annotation;
  //     on a tessellated curve they visually clustered. It's now ONE halo
  //     stroked along every selected annotation's path, batched into a
  //     SINGLE path + SINGLE stroke() call under ctx.globalAlpha specifically
  //     so a shared vertex between two tessellated segments does not
  //     alpha-stack (two separate translucent paints there would composite
  //     to a visibly higher alpha than either paint alone — the exact
  //     "seam" defect a naive per-annotation rgba() fix would still have).
  //     These assertions read REAL canvas pixels (getImageData), reusing
  //     notes-check.mjs's established sample/meanColor/countColor technique
  //     — state alone cannot see a rendering defect. The board here clears
  //     to fully transparent (no image loaded), so a single translucent
  //     paint of SELECT_COLOR at globalAlpha A reports back as the EXACT
  //     source RGB (53,109,255) with alpha ≈ A*255 — compositing over
  //     transparent doesn't blend the RGB toward anything, only alpha
  //     accumulates on a second, separate paint. That is what makes the
  //     alpha channel (not the RGB channel) the sensitive probe for the
  //     stacking bug: single-pass ≈ 0.4*255 ≈ 102, the OLD two-separate
  //     -paints bug would have read ≈ (1-(1-0.4)^2)*255 ≈ 163.
  // ===========================================================================

  const halo = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug, h = window.__DXF;
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();

    // A 3-segment chain (one piece, two real shared vertices) PLUS a lone,
    // far-away line as a SECOND piece in the SAME file/import — two separate
    // imports would each auto-fit-center on the current viewport and land
    // on top of each other; one shared-transform import preserves their
    // relative spacing from the source file instead (this is exactly what
    // "layout-preserving placement" already guarantees).
    await h.importViaRealInput(${JSON.stringify(doc([dxfChain(3, 100), dxfLine(1000, 0, 1100, 0)]))});
    const anns = d.getAnnotations();
    const chain = anns.slice(0, 3);
    const lone = anns[3];
    const groupIds = [...new Set(chain.map(a => a.templateGroupId))];

    // The halo/core widths are set in WORLD units as (screen-px) / zoom (so
    // their ON-SCREEN size stays constant at any zoom — the same convention
    // drawMultiSelectHalo/drawLineCore use) — this is a long-running single
    // page session across every section in this file, so state.zoom here is
    // whatever an EARLIER section left it at, not necessarily 1. Offsets
    // have to divide by the SAME live zoom or they land at the wrong
    // relative distance from the centerline entirely (this failed loudly,
    // landing fully off the halo, before this division was added).
    const z = Math.max(0.0001, d.getView().zoom);
    const OFFSET = 2.75 / z;    // dead center of the halo's annular band (core edge 1.25/z .. halo edge 4.25/z)
    const OLD_DOT_OFFSET = 5.5 / z; // inside the OLD 7.5/z-radius dot, outside the new halo
    const HALF = 1.0 / z;
    const sampleNear = (point, offsetDir, offset, half) => h.sample({
      x: point.x - half, y: point.y + offset * offsetDir - half, width: half * 2, height: half * 2,
    });
    const meanNear = (point, offsetDir, offset, half) => h.meanColor({
      x: point.x - half, y: point.y + offset * offsetDir - half, width: half * 2, height: half * 2,
    });
    const countWhiteNear = (point, offsetDir, offset, half) => h.countColor({
      x: point.x - half, y: point.y + offset * offsetDir - half, width: half * 2, height: half * 2,
    }, [255, 255, 255], 10, 200);

    // Right after import the WHOLE batch (both pieces) is selected as a
    // group — exactly the scenario that surfaced this bug (a fresh DXF
    // import, not a deliberate Shift-click).
    const sharedVertex = chain[0].end; // === chain[1].start
    const midOfMiddleSegment = { x: (chain[1].start.x + chain[1].end.x) / 2, y: (chain[1].start.y + chain[1].end.y) / 2 };

    const dotsGone = countWhiteNear(sharedVertex, -1, OLD_DOT_OFFSET, 0.8);
    const haloAtOffset = meanNear(sharedVertex, -1, OFFSET, HALF);
    const seamMean = meanNear(sharedVertex, -1, OFFSET, HALF);
    const midMean = meanNear(midOfMiddleSegment, -1, OFFSET, HALF);

    // Narrow the selection to just the chain. A plain click on an item
    // ALREADY part of a multi-selection deliberately KEEPS the whole group
    // (pointer-events.js: "so the drag moves them all") — clicking a chain
    // member right now would leave all 4 selected, not narrow to 3. Deselect
    // first (click empty canvas), so the next click is a genuinely fresh
    // pick that re-widens to just its own templateGroupId (the same
    // mechanic the round-9 double-click isolation uses, just without
    // entering single-member edit mode) — freeing the lone line to be
    // hovered as genuinely unselected.
    await h.click(-9999, -9999);
    await h.click(midOfMiddleSegment.x, midOfMiddleSegment.y);
    const selectedAfterClick = d.getState().selectedAnnotationIds.length;

    h.mouse('mousemove', lone.start.x + (lone.end.x - lone.start.x) / 2, lone.start.y);
    await h.settle();
    const hoveredId = d.getState().hoverAnnotationId;
    const loneMid = { x: (lone.start.x + lone.end.x) / 2, y: (lone.start.y + lone.end.y) / 2 };
    const hoverMean = meanNear(loneMid, -1, OFFSET, HALF);

    // Double-click isolates one chain segment to a solo selection — the
    // real single-selection editing handles (drawSelectionHelpers) must be
    // completely unaffected by any of the above.
    h.mouse('mousedown', midOfMiddleSegment.x, midOfMiddleSegment.y);
    h.mouse('mouseup', midOfMiddleSegment.x, midOfMiddleSegment.y);
    h.mouse('dblclick', midOfMiddleSegment.x, midOfMiddleSegment.y);
    await h.settle();
    const soloSelectedCount = d.getState().selectedAnnotationIds.length;
    const soloId = d.getState().selection.id;
    const soloAnn = d.getAnnotations().find(a => a.id === soloId);
    const handleAtEndpoint = h.countColor({
      x: soloAnn.end.x - 0.6, y: soloAnn.end.y - 0.6, width: 1.2, height: 1.2,
    }, [255, 255, 255], 10, 200);

    return {
      annCount: anns.length, groupCount: groupIds.length,
      dotsGoneCount: dotsGone.count, haloAtOffset, seamAlpha: seamMean.a, midAlpha: midMean.a,
      selectedAfterClick, hoveredId, loneId: lone.id, hoverAlpha: hoverMean.a,
      soloSelectedCount, handleAtEndpointCount: handleAtEndpoint.count,
    };
  })()`);

  check(halo.annCount === 4 && halo.groupCount === 1,
    `fixture sanity: a 3-segment chain + a lone line must import as 4 segments with the chain sharing ONE templateGroupId, got ${JSON.stringify({ annCount: halo.annCount, groupCount: halo.groupCount })}`);
  check(halo.dotsGoneCount === 0,
    `the old drawHandle white-fill dot must no longer render at a shared vertex, got ${halo.dotsGoneCount} near-white opaque pixels`);
  check(Math.abs(halo.haloAtOffset.r - 53) < 20 && Math.abs(halo.haloAtOffset.g - 109) < 20 && Math.abs(halo.haloAtOffset.b - 255) < 20 && halo.haloAtOffset.a > 60,
    `the halo must actually paint outside the line's own core stroke, blended toward SELECT_COLOR, got ${JSON.stringify(halo.haloAtOffset)}`);
  check(Math.abs(halo.seamAlpha - 102) < 25,
    `a shared vertex's halo alpha must be close to the single-pass value (~102 for globalAlpha 0.4 over transparent), got ${halo.seamAlpha}`);
  check(halo.seamAlpha < 140,
    `a shared vertex must read well below the OLD double-paint value (~163) — this is the actual regression guard, got ${halo.seamAlpha}`);
  check(Math.abs(halo.seamAlpha - halo.midAlpha) < 20,
    `a shared vertex must read NO DARKER than the middle of a segment (no seam) — vertex ${halo.seamAlpha} vs mid-segment ${halo.midAlpha}`);
  check(halo.selectedAfterClick === 3,
    `a plain click on one chain member must re-select the whole 3-member piece, got ${halo.selectedAfterClick}`);
  check(halo.hoveredId === halo.loneId,
    `a real mousemove over the now-unselected lone line must set hoverAnnotationId to it, got ${halo.hoveredId} vs expected ${halo.loneId}`);
  check(Math.abs(halo.hoverAlpha - 56) < 20,
    `hover's own halo alpha must be close to its single-pass value (~56 for globalAlpha 0.22), got ${halo.hoverAlpha}`);
  check(halo.hoverAlpha < halo.seamAlpha - 20,
    `hover must read visibly LIGHTER than the multi-select halo (0.22 vs 0.4 globalAlpha) — hover ${halo.hoverAlpha} vs selection ${halo.seamAlpha}`);
  check(halo.soloSelectedCount === 1,
    `double-clicking one chain segment must isolate it to a solo selection, got ${halo.soloSelectedCount}`);
  check(halo.handleAtEndpointCount > 0,
    'a real single-selection must still show its drawSelectionHelpers white-fill endpoint handle, unaffected by the halo change');

  // ===========================================================================
  // 12. ADR 0070: the Pattern Pieces panel. A grading-nest DXF places every
  //     size's piece at the same board position, overlapping (ADR 0069's
  //     Context) — this panel lists every templateGroupId group so the TD can
  //     tell them apart (by the source INSERT's block name, when the DXF
  //     names its blocks) and remove the ones they don't want. Manual, not
  //     auto-detected: ADR 0067's own research found no reliable way to guess
  //     which size is "standard."
  // ===========================================================================

  const patternPieces = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const resetBoard = async () => {
      const p = d.exportProject();
      p.state.annotations = []; p.state.images = []; p.state.graphics = []; p.state.notes = [];
      p.state.templateGroupLabels = {};
      await d.loadProject(p);
      document.getElementById('modeManualBtn').click();
      if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    };

    // A. Two named blocks, far apart (never touching, so each is its own
    // piece regardless of the instance-boundary rule) — one carries a real
    // grading-nest-style name, proving the label reaches the panel.
    await resetBoard();
    const namedDoc = ${JSON.stringify(docWithBlocks(
      [dxfBlock('CUP_36C', dxfLine(0, 0, 10, 0)), dxfBlock('CUP_38C', dxfLine(0, 0, 10, 0))],
      [dxfInsert('CUP_36C', 0, 0), dxfInsert('CUP_38C', 1000, 0)],
    ))};
    const namedImport = d.dxf.importText(namedDoc);
    const namedGroups = d.dxf.patternPieces.groups();
    const panelAutoOpen = d.dxf.patternPieces.isOpen();

    // B. Direct, unblocked entities (instance 0) fall back to a positional
    // label — the vast majority of real files that DO have block names still
    // leave instance 0 unlabeled (nothing was ever placed via INSERT there).
    await resetBoard();
    const scatteredDoc = ${JSON.stringify(doc([dxfScatteredPieces(2)]))};
    d.dxf.importText(scatteredDoc);
    const scatteredGroups = d.dxf.patternPieces.groups();

    // C. Removing one group deletes exactly its annotations and its label,
    // leaves the other group untouched, and is a plain annotation deletion —
    // no new hidden-state field, so the normal history stack covers undo.
    await resetBoard();
    d.dxf.importText(namedDoc);
    const beforeRemove = d.dxf.patternPieces.groups();
    const keepGroupId = beforeRemove.find(g => g.label === 'CUP_38C').groupId;
    const killGroupId = beforeRemove.find(g => g.label === 'CUP_36C').groupId;
    d.dxf.patternPieces.remove([killGroupId]);
    const afterRemove = { anns: d.getAnnotations(), groups: d.dxf.patternPieces.groups(), exported: d.exportProject() };

    // D. A single-piece import (nothing to choose between) must not
    // auto-open the panel.
    await resetBoard();
    const soloDoc = ${JSON.stringify(doc([dxfLine(0, 0, 10, 0)]))};
    d.dxf.importText(soloDoc);
    const soloAutoOpen = d.dxf.patternPieces.isOpen();

    // E. Real DOM: Tools-menu entry opens the panel; the close button closes
    // it; the live checkbox + "Remove unchecked" button flow (not the debug
    // hook) removes exactly the unchecked piece from the board.
    await resetBoard();
    d.dxf.patternPieces.close();
    document.getElementById('toolsMenuBtn').click();
    const btnVisible = document.getElementById('patternPiecesBtn').offsetParent !== null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    d.dxf.importText(namedDoc);
    const openedByImport = d.dxf.patternPieces.isOpen();
    document.getElementById('patternPiecesCloseBtn').click();
    const closedByButton = d.dxf.patternPieces.isOpen();
    document.getElementById('patternPiecesBtn').click();
    const reopenedByToolsMenu = d.dxf.patternPieces.isOpen();
    const rows = Array.from(document.querySelectorAll('#patternPiecesBody .pattern-piece-row'));
    const row36 = rows.find(r => r.querySelector('.pattern-piece-label').textContent === 'CUP_36C');
    row36.querySelector('.pattern-piece-checkbox').click();
    document.getElementById('patternPiecesApplyBtn').click();
    const afterDomRemove = d.getAnnotations();

    return {
      namedImport, namedGroups, panelAutoOpen, scatteredGroups,
      beforeRemove, afterRemove, soloAutoOpen,
      btnVisible, openedByImport, closedByButton, reopenedByToolsMenu,
      rowsCountBeforeDom: rows.length, afterDomRemoveLen: afterDomRemove.length,
    };
  })()`);

  check(patternPieces.namedImport.ok === true && patternPieces.namedImport.pieceCount === 2,
    `fixture sanity: two far-apart named blocks must import as 2 pieces, got ${JSON.stringify(patternPieces.namedImport)}`);
  check(patternPieces.namedGroups.length === 2
    && patternPieces.namedGroups.map(g => g.label).sort().join(',') === 'CUP_36C,CUP_38C',
    `a DXF INSERT's own block name must reach the panel as that piece's label, got ${JSON.stringify(patternPieces.namedGroups.map(g => g.label))}`);
  check(patternPieces.namedGroups.every(g => g.count === 1),
    `each named piece here is a single LINE, got ${JSON.stringify(patternPieces.namedGroups.map(g => g.count))}`);
  check(patternPieces.panelAutoOpen === true,
    'importing more than one piece must auto-open the Pattern Pieces panel (this is the grading-nest declutter moment)');
  check(patternPieces.scatteredGroups.length === 2
    && patternPieces.scatteredGroups.map(g => g.label).sort().join(',') === 'Piece 1,Piece 2',
    `direct entities (no INSERT, no block name) must fall back to a positional label, got ${JSON.stringify(patternPieces.scatteredGroups.map(g => g.label))}`);

  check(patternPieces.afterRemove.groups.length === 1 && patternPieces.afterRemove.groups[0].label === 'CUP_38C',
    `removing one group must leave exactly the other piece, got ${JSON.stringify(patternPieces.afterRemove.groups)}`);
  check(patternPieces.afterRemove.anns.length === 1 && patternPieces.afterRemove.anns[0].templateGroupId === patternPieces.beforeRemove.find(g => g.label === 'CUP_38C').groupId,
    `removePatternPieceGroups must be a plain annotation deletion — only the removed group's annotations disappear from state.annotations, got ${JSON.stringify(patternPieces.afterRemove.anns.map(a => a.templateGroupId))}`);
  check(!(patternPieces.afterRemove.exported.state.templateGroupLabels
    && Object.prototype.hasOwnProperty.call(patternPieces.afterRemove.exported.state.templateGroupLabels, patternPieces.beforeRemove.find(g => g.label === 'CUP_36C').groupId)),
    'the removed group\'s label must be cleaned out of templateGroupLabels, not left as a stale entry');
  check(patternPieces.afterRemove.exported.state.templateGroupLabels[patternPieces.beforeRemove.find(g => g.label === 'CUP_38C').groupId] === 'CUP_38C',
    `templateGroupLabels must persist in the project snapshot (ADR 0070 — a real decision, not a session-only review toggle), got ${JSON.stringify(patternPieces.afterRemove.exported.state.templateGroupLabels)}`);

  check(patternPieces.soloAutoOpen === false,
    'a single-piece import has nothing to choose between and must not auto-open the panel');

  check(patternPieces.btnVisible === true,
    '"Pattern pieces…" must be visible in the Tools menu in Sketch Focus');
  check(patternPieces.openedByImport === true, 'a multi-piece import must open the panel');
  check(patternPieces.closedByButton === false, 'the panel close button must actually close it');
  check(patternPieces.reopenedByToolsMenu === true, 'the Tools-menu entry must reopen the panel on demand');
  check(patternPieces.rowsCountBeforeDom === 2, `the panel must render one row per piece, got ${patternPieces.rowsCountBeforeDom}`);
  check(patternPieces.afterDomRemoveLen === 1,
    `unchecking one row and clicking "Remove unchecked" through the REAL DOM (not the debug hook) must remove exactly that piece, got ${patternPieces.afterDomRemoveLen} annotations left`);

  // ===========================================================================
  // 13. TD-reported bug: "Move piece only moves one segment." Double-clicking
  //     a piece member enters templateGroupEditId (per-member edit) with no
  //     keyboard exit before this fix — a TD who forgot they were in it would
  //     drag one line expecting the whole piece to move. Escape now exits it
  //     (mirrors bgExitEdit's own Escape priority), and the tool-status text
  //     names the mode so it isn't silently forgotten once the entry toast
  //     fades.
  // ===========================================================================

  const memberEdit = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();

    await h.importViaRealInput(${JSON.stringify(doc([dxfChain(3, 100)]))});
    const anns = d.getAnnotations();
    const groupId = anns[0].templateGroupId;
    const mid = (a) => ({ x: (a.start.x + a.end.x) / 2, y: (a.start.y + a.end.y) / 2 });
    const middle = anns[1]; // the shared-interior segment of the 3-piece chain
    const midPt = mid(middle);

    await h.click(-9999, -9999);
    await h.click(midPt.x, midPt.y);
    const wholeGroupSelected = d.getState().selectedAnnotationIds.length;

    h.mouse('mousedown', midPt.x, midPt.y);
    h.mouse('mouseup', midPt.x, midPt.y);
    h.mouse('dblclick', midPt.x, midPt.y);
    await h.settle();
    const editIdAfterDblclick = d.getState().templateGroupEditId;
    const soloSelectedAfterDblclick = d.getState().selectedAnnotationIds.length;
    const statusDuringEdit = document.getElementById('toolStatus').textContent;

    const beforeStuckDrag = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end }));
    await h.drag(midPt.x, midPt.y, 30, 30);
    const afterStuckDrag = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await h.settle();
    const editIdAfterEscape = d.getState().templateGroupEditId;
    const selectedAfterEscape = d.getState().selectedAnnotationIds.slice().sort();
    const statusAfterEscape = document.getElementById('toolStatus').textContent;

    // The stuck drag above physically moved segment[1] away from midPt (that
    // was the bug) — dragging from midPt again would now miss it entirely.
    // segment[0] never moved, so its CURRENT midpoint is still a real point
    // on the piece; the whole-piece-selection contract this proves does not
    // care which member the drag starts from.
    const first = d.getAnnotations().find(a => a.id === anns[0].id);
    const freshMidPt = mid(first);
    const beforeWholeDrag = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end }));
    await h.drag(freshMidPt.x, freshMidPt.y, -20, 15);
    const afterWholeDrag = d.getAnnotations().map(a => ({ id: a.id, start: a.start, end: a.end }));

    return {
      groupId, wholeGroupSelected, editIdAfterDblclick, soloSelectedAfterDblclick, statusDuringEdit,
      beforeStuckDrag, afterStuckDrag, editIdAfterEscape, selectedAfterEscape, statusAfterEscape,
      allIds: anns.map(a => a.id).sort(), beforeWholeDrag, afterWholeDrag,
    };
  })()`);

  check(memberEdit.wholeGroupSelected === 3, `precondition: a plain click on a 3-segment chain piece must select the whole group, got ${memberEdit.wholeGroupSelected}`);
  check(memberEdit.editIdAfterDblclick === memberEdit.groupId && memberEdit.soloSelectedAfterDblclick === 1,
    `double-clicking a piece member must enter templateGroupEditId and narrow to a solo selection, got ${JSON.stringify({ editId: memberEdit.editIdAfterDblclick, solo: memberEdit.soloSelectedAfterDblclick })}`);
  check(/editing one line of this piece/i.test(memberEdit.statusDuringEdit) && /Esc/.test(memberEdit.statusDuringEdit),
    `the tool-status sentence must name member-edit mode and mention Esc while it is active, got ${JSON.stringify(memberEdit.statusDuringEdit)}`);
  {
    const movedIds = memberEdit.afterStuckDrag.filter(a => {
      const b = memberEdit.beforeStuckDrag.find(x => x.id === a.id);
      return Math.abs(a.start.x - b.start.x) > 0.5 || Math.abs(a.start.y - b.start.y) > 0.5;
    }).map(a => a.id);
    check(movedIds.length === 1,
      `reproduces the TD-reported bug: dragging while stuck in member-edit mode must move exactly ONE segment, not the whole piece, got moved=${JSON.stringify(movedIds)}`);
  }
  check(memberEdit.editIdAfterEscape === null,
    `Escape must clear templateGroupEditId, got ${memberEdit.editIdAfterEscape}`);
  check(JSON.stringify(memberEdit.selectedAfterEscape) === JSON.stringify(memberEdit.allIds),
    `Escape must re-select the WHOLE piece (the fix's actual payoff), got ${JSON.stringify(memberEdit.selectedAfterEscape)} vs all ids ${JSON.stringify(memberEdit.allIds)}`);
  check(!/editing one line of this piece/i.test(memberEdit.statusAfterEscape),
    `the tool-status sentence must return to the normal Select text once member-edit mode is exited, got ${JSON.stringify(memberEdit.statusAfterEscape)}`);
  for (const b of memberEdit.beforeWholeDrag) {
    const a = memberEdit.afterWholeDrag.find(x => x.id === b.id);
    check(Math.abs((a.start.x - b.start.x) + 20) < 0.5 && Math.abs((a.start.y - b.start.y) - 15) < 0.5,
      `the fix's payoff: after Escape, dragging must move EVERY segment of the piece by the same delta, id=${b.id} moved by (${a.start.x - b.start.x}, ${a.start.y - b.start.y})`);
  }

  // ===========================================================================
  // 14. ADR 0071: the Notch tool. Click near a piece's outline to drop a small
  //     perpendicular tick mark there — a garment-pattern alignment notch.
  //     Driven through the REAL Tools-menu button and real mouse/keyboard
  //     dispatch throughout, not the internal placeNotchAt function directly.
  // ===========================================================================

  const notchTool = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();

    // A single horizontal LINE piece — its tangent is along X, so the notch
    // perpendicular must land along Y (angle near ±90°), an easy exact check.
    await h.importViaRealInput(${JSON.stringify(doc([dxfLine(0, 0, 200, 0)]))});
    const line = d.getAnnotations()[0];
    const mid = { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 };

    document.getElementById('toolsMenuBtn').click();
    document.getElementById('notchToolBtn').click();
    const toolAfterArm = d.getState().tool;

    await h.click(mid.x, mid.y);
    const afterPlace = { notches: d.getNotches(), tool: d.getState().tool, selection: d.getState().selection };

    // Far from any line: no notch, no crash — just a toast.
    await h.click(mid.x, mid.y - 5000);
    const afterMiss = d.getNotches().length;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const toolAfterEscape = d.getState().tool;

    const placed = afterPlace.notches[0];
    await h.click(placed.x, placed.y);
    const selectionAfterClick = d.getState().selection;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    const afterDelete = d.getNotches().length;

    document.getElementById('undoBtn').click();
    const afterUndo = d.getNotches();

    const exported = d.exportProject();
    await d.loadProject(exported);
    const afterReload = d.getNotches();

    return { toolAfterArm, afterPlace, mid, afterMiss, toolAfterEscape, placed, selectionAfterClick, afterDelete, afterUndo, afterReload };
  })()`);

  check(notchTool.toolAfterArm === 'notch', `clicking the Tools-menu Notch button must arm state.tool='notch', got ${notchTool.toolAfterArm}`);
  check(notchTool.afterPlace.notches.length === 1, `clicking near the line must place exactly one notch, got ${notchTool.afterPlace.notches.length}`);
  check(Math.hypot(notchTool.afterPlace.notches[0].x - notchTool.mid.x, notchTool.afterPlace.notches[0].y - notchTool.mid.y) < 1,
    `the notch must land at the nearest point on the line (the click's own midpoint here), got ${JSON.stringify(notchTool.afterPlace.notches[0])} vs mid ${JSON.stringify(notchTool.mid)}`);
  {
    const deg = Math.abs((notchTool.afterPlace.notches[0].angle * 180 / Math.PI) % 180);
    check(Math.abs(deg - 90) < 1, `a notch on a horizontal line must point perpendicular to it (~90°), got ${deg}°`);
  }
  check(notchTool.afterPlace.tool === 'notch', 'the Notch tool must stay armed after placing one (like Text/drawing tools), not revert to Select');
  check(notchTool.afterPlace.selection.kind === 'notch' && notchTool.afterPlace.selection.id === notchTool.afterPlace.notches[0].id,
    `placing a notch must select it, got ${JSON.stringify(notchTool.afterPlace.selection)}`);
  check(notchTool.afterMiss === 1, `clicking 5000 units from any line must place NO notch (still just the first one), got ${notchTool.afterMiss}`);
  check(notchTool.toolAfterEscape === 'select', `Escape must exit the Notch tool back to Select, got ${notchTool.toolAfterEscape}`);
  check(notchTool.selectionAfterClick.kind === 'notch' && notchTool.selectionAfterClick.id === notchTool.placed.id,
    `clicking an existing notch with the Select tool must select it, got ${JSON.stringify(notchTool.selectionAfterClick)}`);
  check(notchTool.afterDelete === 0, `Delete with a notch selected must remove it, got ${notchTool.afterDelete} left`);
  check(notchTool.afterUndo.length === 1 && notchTool.afterUndo[0].id === notchTool.placed.id,
    `Undo must restore the deleted notch (history.js makeSnapshot/restoreSnapshot), got ${JSON.stringify(notchTool.afterUndo)}`);
  check(notchTool.afterReload.length === 1 && notchTool.afterReload[0].id === notchTool.placed.id,
    `state.notches must round-trip through exportProject/loadProject, got ${JSON.stringify(notchTool.afterReload)}`);

  // ===========================================================================
  // 15. ADR 0072: "Simplify" a piece's redundant collinear points — a TD
  //     reported many unnecessary points left over after DXF import. Merges
  //     runs of near-perfectly-collinear straight segments into one; a real
  //     corner (a genuine angle change) always stays a separate segment.
  // ===========================================================================

  const simplify = await s.eval(`(async () => {
    const h = window.__DXF, d = window.__braAutoModeDebug;
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();

    // 5 collinear segments along y=0 from x=0 to x=500, then a real 90°
    // corner up to (500, 100) — the corner must survive as its own segment.
    await h.importViaRealInput(${JSON.stringify(doc([
      dxfLine(0, 0, 100, 0), dxfLine(100, 0, 200, 0), dxfLine(200, 0, 300, 0),
      dxfLine(300, 0, 400, 0), dxfLine(400, 0, 500, 0), dxfLine(500, 0, 500, 100),
    ]))});
    const before = d.getAnnotations();
    const groupId = before[0].templateGroupId;
    const runResult = d.dxf.patternPieces.simplify(groupId);
    const after = d.getAnnotations();

    // A no-op case: a single straight line has nothing to merge.
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await h.importViaRealInput(${JSON.stringify(doc([dxfLine(0, 0, 10, 0)]))});
    const soloBefore = d.getAnnotations();
    const soloGroupId = soloBefore[0].templateGroupId;
    const noopResult = d.dxf.patternPieces.simplify(soloGroupId);
    const soloAfter = d.getAnnotations();

    // Real DOM: open the panel, click THIS row's Simplify button.
    await d.loadProject(await (async () => {
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; return p;
    })());
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    await h.importViaRealInput(${JSON.stringify(doc([
      dxfLine(0, 0, 100, 0), dxfLine(100, 0, 200, 0), dxfLine(200, 0, 500, 0),
    ]))});
    d.dxf.patternPieces.open();
    const rowsBefore = Array.from(document.querySelectorAll('#patternPiecesBody .pattern-piece-row'));
    const simplifyBtn = Array.from(rowsBefore[0].querySelectorAll('.pattern-piece-mini-btn')).find(b => b.textContent === 'Simplify');
    simplifyBtn.click();
    const annsAfterDomClick = d.getAnnotations();

    return { before, runResult, after, noopResult, soloBefore, soloAfter, annsAfterDomClick };
  })()`);

  check(simplify.runResult.chains === 1 && simplify.runResult.removed === 4,
    `5 collinear segments must merge into 1 run (removing 4 annotations), got ${JSON.stringify(simplify.runResult)}`);
  check(simplify.after.length === 2, `the piece must end with exactly 2 annotations (the merged run + the untouched corner), got ${simplify.after.length}`);
  {
    const merged = simplify.after.find(a => Math.abs(a.start.y - a.end.y) < 0.01 && Math.abs(a.start.x - a.end.x) > 400);
    check(!!merged, `the merged annotation must span the full collinear run, got ${JSON.stringify(simplify.after)}`);
    const firstStart = simplify.before[0].start, lastOfRunEnd = simplify.before[4].end;
    check(Math.hypot(merged.start.x - firstStart.x, merged.start.y - firstStart.y) < 0.5
      && Math.hypot(merged.end.x - lastOfRunEnd.x, merged.end.y - lastOfRunEnd.y) < 0.5,
      `the merged annotation's endpoints must exactly match the run's true first start and last end, got ${JSON.stringify(merged)} vs expected start ${JSON.stringify(firstStart)} end ${JSON.stringify(lastOfRunEnd)}`);
    const corner = simplify.before[5];
    const cornerStill = simplify.after.find(a => Math.hypot(a.start.x - corner.start.x, a.start.y - corner.start.y) < 0.5
      && Math.hypot(a.end.x - corner.end.x, a.end.y - corner.end.y) < 0.5);
    check(!!cornerStill, `the real 90° corner segment must survive completely untouched, got ${JSON.stringify(simplify.after)}`);
  }
  check(simplify.noopResult.chains === 0 && simplify.noopResult.removed === 0,
    `a single-segment piece has nothing to merge, got ${JSON.stringify(simplify.noopResult)}`);
  check(simplify.soloAfter.length === simplify.soloBefore.length,
    'a no-op simplify must leave the annotation count unchanged');
  check(simplify.annsAfterDomClick.length === 1,
    `clicking the REAL "Simplify" button in the Pattern Pieces panel must merge the 3-segment collinear piece down to 1 annotation, got ${simplify.annsAfterDomClick.length}`);

  const errors = await s.eval('window.__dxfErrors || []');
  check(errors.length === 0, 'browser console errors: ' + errors.join(' | '));
  await s.close();
  console.log(`PASS  dxf-import-check   ${passed}/${passed} assertions ok`);
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
