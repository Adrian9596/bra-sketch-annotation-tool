#!/usr/bin/env node
// US-104: "Open DXF file" import in Sketch Focus.
//
// The story's own Validation table is large; this suite covers the
// load-bearing claims rather than every listed permutation: the DXF
// group-code/section parser (including the BOM/CRLF/trailing-newline
// normalization that has to run BEFORE the even/odd pair check, or an
// ordinary well-formed file reads as corrupt), the planarity gate, the
// malformed-entity contract, the bulge-to-arc sign convention, piece
// detection (connectivity + containment merge + no over-merge), the three
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
    document.getElementById('toolsMenuBtn').click();
    await settle();
    const input = document.getElementById('dxfImportFileInput');
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
  return { d, canvas, settle, toClient, mouse, click, drag, importViaRealInput, solidImage };
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

  // Section scoping: BLOCKS content is never entities; a POLYLINE without
  // SEQEND and a missing ENTITIES section are whole-file, not per-entity.
  const blocksOnly = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(rawDoc([
    sectionBlock('BLOCKS', dxfLine(0, 0, 10, 0)), sectionBlock('ENTITIES', []),
  ]))})`);
  check(blocksOnly.ok === false && blocksOnly.reason === 'empty',
    `geometry defined only in BLOCKS with an empty ENTITIES must report "no supported entities", got ${JSON.stringify(blocksOnly)}`);
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
  // 2. Pure placement transform — the exact reused createImageRecord formula.
  // ===========================================================================

  const fit = await s.eval(`window.__braAutoModeDebug.dxf.computePlacement(
    { x: 0, y: 0, width: 1000, height: 500 }, { width: 1000, height: 800 }, { x: 0, y: 0 })`);
  check(Math.abs(fit.scale - 0.42) < 1e-9 && Math.abs(fit.outputWidth - 420) < 1e-6 && Math.abs(fit.outputHeight - 210) < 1e-6
    && Math.abs(fit.originX + 210) < 1e-6 && Math.abs(fit.originY + 105) < 1e-6,
    `the 42%-viewport-fit auto-fit box must match createImageRecord's own formula exactly, got ${JSON.stringify(fit)}`);
  const floored = await s.eval(`window.__braAutoModeDebug.dxf.computePlacement(
    { x: 0, y: 0, width: 10, height: 10 }, { width: 100, height: 100 }, { x: 0, y: 0 })`);
  check(Math.abs(floored.scale - 18) < 1e-9,
    `a tiny drawing in a small viewport must hit the 180px floor on maxW/maxH (scale 18), got ${JSON.stringify(floored)}`);

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

  // Per-piece cap is 1000, NOT 80 (that number is normalizeShapeStamp's own
  // Template-member cap, unrelated) — see the constant's own comment in
  // src/manual/dxf-import.js for the real production file (3380.dxf) that
  // forced this: single real garment pieces there ran up to 295 segments.
  const cap999 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfChain(999)]))})`);
  const cap1000 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfChain(1000)]))})`);
  const cap1001 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfChain(1001), dxfLine(-100, -100, -90, -100)]))})`);
  check(cap999.ok === true && cap999.pieces[0].length === 999, `a 999-segment piece must import fully, got ${JSON.stringify(cap999.pieces?.map(p=>p.length))}`);
  check(cap1000.ok === true && cap1000.pieces[0].length === 1000, `an exactly-1000-segment piece must import fully, got ${JSON.stringify(cap1000.pieces?.map(p=>p.length))}`);
  check(cap1001.ok === true && cap1001.skippedOversizedPieces === 1 && cap1001.pieces.length === 1 && cap1001.pieces[0].length === 1,
    `a 1001-segment piece must be skipped while a smaller valid piece in the same file still imports, got ${JSON.stringify(cap1001)}`);

  const pieces40 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfScatteredPieces(40)]))})`);
  const pieces41 = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([dxfScatteredPieces(41)]))})`);
  check(pieces40.ok === true && pieces40.pieces.length === 40, `exactly 40 pieces must import, got ${JSON.stringify(pieces40.ok)} ${pieces40.pieces?.length}`);
  check(pieces41.ok === false && pieces41.reason === 'piece-cap', `41 pieces must be a whole-file piece-cap rejection, got ${JSON.stringify(pieces41)}`);

  // Four 800-segment chains, spaced far apart (4*800=3200 > 3000 total, each
  // piece under the 1000 per-piece cap, 4 pieces well under the 40 cap).
  const fourChains = [0, 5000, 10000, 15000].flatMap(offset => {
    const segs = [];
    for (let i = 0; i < 800; i += 1) segs.push(...dxfLine(offset + i, 0, offset + i + 1, 0));
    return segs;
  });
  const totalCap = await s.eval(`window.__braAutoModeDebug.dxf.parse(${JSON.stringify(doc([fourChains]))})`);
  check(totalCap.ok === false && totalCap.reason === 'total-cap',
    `4 pieces of 800 segments (3200 total, each under the 1000 per-piece cap, 4 under the 40-piece cap) must be rejected by the 3000 combined-output cap, got ${JSON.stringify(totalCap)}`);

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
    return { selection: d.getState().selectedAnnotationIds, uncalibratedText, expectedTotalPx, outlinePerimeterPx, annCount: anns.length };
  })()`);
  check(readout.annCount === 9, `outline(4) + circle(4 chunks) + grainline(1) must be 9 annotations, got ${readout.annCount}`);
  check(readout.selection.length === 9, `clicking the outline of this piece must select the whole 9-annotation group, got ${JSON.stringify(readout.selection)}`);
  const expectedRounded = Math.round(readout.expectedTotalPx);
  check(readout.uncalibratedText.includes(expectedRounded + ' px') && /uncalibrated/i.test(readout.uncalibratedText),
    `the status line must show the uncalibrated total length (hand-computed ${expectedRounded}px from the real, scaled geometry) with an "(uncalibrated)" note, got ${JSON.stringify(readout.uncalibratedText)}`);
  check(readout.expectedTotalPx > readout.outlinePerimeterPx + 1,
    `the readout must sum MORE than the outline's own perimeter — it includes the internal circle and grainline, got total=${readout.expectedTotalPx} vs outline-only=${readout.outlinePerimeterPx}`);

  // ===========================================================================
  // 8. Tools-menu visibility and Command Palette availability per focus
  //    state — the "visible/available only in Sketch Focus" Acceptance
  //    Criterion, equivalent to what board-toolbar-check/keyboard-shortcuts-
  //    check assert for every other Sketch-Focus-only control.
  // ===========================================================================

  const focusGating = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('toolsMenuBtn').click();
    const inSketch = {
      sketchMode: d.getState().sketchMode,
      btnVisible: document.getElementById('dxfImportBtn').offsetParent !== null,
      command: d.commands.list().find(c => c.id === 'board.template.import-dxf'),
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('sketchFocusBtn').click(); // -> POM Focus
    document.getElementById('toolsMenuBtn').click();
    const inPom = {
      sketchMode: d.getState().sketchMode,
      btnVisible: document.getElementById('dxfImportBtn').offsetParent !== null,
      command: d.commands.list().find(c => c.id === 'board.template.import-dxf'),
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('sketchFocusBtn').click(); // back to Sketch Focus
    return { inSketch, inPom };
  })()`);
  check(focusGating.inSketch.sketchMode === true && focusGating.inSketch.btnVisible === true,
    `"Open DXF file" must be visible in the Tools menu while in Sketch Focus, got ${JSON.stringify(focusGating.inSketch)}`);
  check(!!focusGating.inSketch.command && focusGating.inSketch.command.availability.enabled === true,
    `the Command Palette entry must be enabled in Sketch Focus, got ${JSON.stringify(focusGating.inSketch.command)}`);
  check(focusGating.inPom.sketchMode === false && focusGating.inPom.btnVisible === false,
    `"Open DXF file" must be hidden in the Tools menu outside Sketch Focus (POM Focus), got ${JSON.stringify(focusGating.inPom)}`);
  check(!!focusGating.inPom.command && focusGating.inPom.command.availability.enabled === false
    && /Available in Sketch Focus/i.test(focusGating.inPom.command.availability.reason),
    `the Command Palette entry must be disabled outside Sketch Focus with the stated reason, got ${JSON.stringify(focusGating.inPom.command)}`);

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
