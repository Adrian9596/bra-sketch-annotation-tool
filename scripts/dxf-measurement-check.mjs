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
// ADR 0073: BLOCK/INSERT + HEADER builders (private copies, same convention
// as this file's other builders — dxf-import-check.mjs's versions have
// different signatures, deliberately not shared).
const dxfBlock = (name, entityArrays) => [P(0, 'BLOCK'), P(2, name), ...entityArrays.flat(), P(0, 'ENDBLK')];
const dxfInsert = (name, x, y, extra = {}) => {
  const out = [P(0, 'INSERT'), P(2, name), P(10, x), P(20, y)];
  if (extra.sx !== undefined) out.push(P(41, extra.sx));
  if (extra.sy !== undefined) out.push(P(42, extra.sy));
  if (extra.rot !== undefined) out.push(P(50, extra.rot));
  return out;
};
const docWithBlocks = (blockArrays, entityArrays) => pairsToText([
  ...sectionBlock('BLOCKS', blockArrays.flat()),
  ...sectionBlock('ENTITIES', entityArrays.flat()),
  P(0, 'EOF'),
]);
const docWithHeader = (headerPairs, entityArrays) => pairsToText([
  ...sectionBlock('HEADER', headerPairs),
  ...sectionBlock('ENTITIES', entityArrays.flat()),
  P(0, 'EOF'),
]);
// Closed square, side 10, four straight LINEs.
const SQUARE_DXF = doc([dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]);
// Open 5-segment chain along the x axis: (0,0)-(50,0), 10 units apart.
const CHAIN_DXF = doc(Array.from({ length: 5 }, (_, i) => dxfLine(i * 10, 0, (i + 1) * 10, 0)));
// US-114: two DIFFERENT-sized blocks ("PIECE_S"/"PIECE_M", 10x10 and 12x12
// squares) both INSERTed at the exact same point (0,0) — the real-world
// grading-nest convention (ADR 0069/0070: every chosen size's piece placed
// at the same board position) taken to its most deterministic extreme: their
// (0,0) corners aren't just close, they're EXACTLY coincident in board space
// (distance 0, not merely "within the tie band"). Proves both the near-tie
// snap fix (section 14) and the size filter (also section 14) against one
// fixture — a real factory file that exhibits this is `demo/DXF file/
// 3708.dxf`, confirmed there at 0.06 native units apart, not exactly 0; this
// fixture is the deterministic, hand-computable stand-in.
const SIZE_FILTER_DXF = docWithBlocks(
  [
    dxfBlock('PIECE_S', [dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]),
    dxfBlock('PIECE_M', [dxfLine(0, 0, 12, 0), dxfLine(12, 0, 12, 12), dxfLine(12, 12, 0, 12), dxfLine(0, 12, 0, 0)]),
  ],
  [dxfInsert('PIECE_S', 0, 0), dxfInsert('PIECE_M', 0, 0)],
);
// Found 2026-09-01 on a real single-size factory file (2984-SONASHAPE.dxf):
// 2+ distinct block-name labels is NOT the same signal as a grading nest —
// these two blocks are different, ordinary garment pieces placed side by
// side (never overlapping), the opposite of SIZE_FILTER_DXF above. The
// filter must not activate for this shape at all.
const NON_OVERLAPPING_PIECES_DXF = docWithBlocks(
  [
    dxfBlock('PIECE_A', [dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]),
    dxfBlock('PIECE_B', [dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]),
  ],
  [dxfInsert('PIECE_A', 0, 0), dxfInsert('PIECE_B', 100, 100)],
);
// Found 2026-09-01 on a real factory file (3380.dxf): every piece authored
// as two back-to-back, byte-identical closed outlines. ADR 0073's route-
// search dedupe never reached point-PLACEMENT, so a click near one of these
// segments' shared midpoint hit both copies and forced a pointless Tab/Enter
// choice between two options that measure identically. One flat piece
// (no BLOCK/INSERT, like the real file), 4 unique edges then the exact same
// 4 edges again.
const DUPLICATE_SEGMENT_DXF = doc([
  dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0),
  dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0),
]);

// ADR 0084 (found 2026-09-02 on a real file, K01543CB-SE0583-STRIKE
// COST-TAILONR.dxf): a nest that grades TWO different pieces at the same
// position — here a cup outer (plain square) and a cup lining (same square
// plus a diagonal, so it is genuinely different geometry, not a duplicate)
// each in sizes S and M, all four INSERTed at (0,0). Block names follow the
// corpus-wide `<piece>_<size>` convention. Filtering to size S must keep
// BOTH S pieces reachable; US-114/117's whole-name rule hid LINING_S the
// moment CUP_S was selected.
const TWO_FAMILY_NEST_DXF = docWithBlocks(
  [
    dxfBlock('CUP_S', [dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]),
    dxfBlock('CUP_M', [dxfLine(0, 0, 12, 0), dxfLine(12, 0, 12, 12), dxfLine(12, 12, 0, 12), dxfLine(0, 12, 0, 0)]),
    dxfBlock('LINING_S', [dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0), dxfLine(0, 0, 10, 10)]),
    dxfBlock('LINING_M', [dxfLine(0, 0, 12, 0), dxfLine(12, 0, 12, 12), dxfLine(12, 12, 0, 12), dxfLine(0, 12, 0, 0), dxfLine(0, 0, 12, 12)]),
  ],
  [dxfInsert('CUP_S', 0, 0), dxfInsert('CUP_M', 0, 0), dxfInsert('LINING_S', 0, 0), dxfInsert('LINING_M', 0, 0)],
);
// ADR 0084: a full circle is ONE native arc segment whose two ends coincide
// — a self-loop edge in the path graph, the corpus's only real arc shape
// (a drill-hole mark in 2875_ LiftyChic_Crossian.dxf).
const CIRCLE_DXF = doc([dxfCircle(0, 0, 5)]);

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
  await section8InsertBlocksAndUnits(s);
  await section9PieceEditInvalidation(s);
  await section10Snap(s);
  await section11MeasurementsPanel(s);
  await section12SeamMatch(s);
  await section13DraggablePanels(s);
  await section14SnapTiesAndSizeFilter(s);
  await section15SizeFilterOverlapGateAndDuplicateSegments(s);
  await section16SizeTokensAndLoopRoutes(s);
  await section17DurablePatternSource(s);

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

// ---- Section 17: ADR 0088 durable source / ephemeral measurements ----------
async function section17DurablePatternSource(s) {
  const result = await s.eval(`(async () => {
    const dbg = window.__braAutoModeDebug;
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    const imported = dbg.dxf.importText(${JSON.stringify(SQUARE_DXF)},
      { left: 0, top: 0, width: 1200, height: 800 }, 'durable-square.dxf');
    await new Promise(r => setTimeout(r, 120));

    // Create a real temporary M1 through the production button + pointer path.
    const canvas = document.getElementById('boardCanvas');
    const view = dbg.getView();
    const rect = canvas.getBoundingClientRect();
    const toScreen = p => ({ x: rect.left + p.x * view.zoom + view.panX, y: rect.top + p.y * view.zoom + view.panY });
    const clickWorld = p => {
      const q = toScreen(p);
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: q.x, clientY: q.y, bubbles: true, button: 0 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: q.x, clientY: q.y, bubbles: true, button: 0 }));
    };
    document.getElementById('dxfMeasureOutBtn').click();
    clickWorld(dbg.dxf.measure.nativeToBoardLive({ x: 0, y: 0 }, 0));
    clickWorld(dbg.dxf.measure.nativeToBoardLive({ x: 10, y: 10 }, 0));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const temporaryCount = dbg.dxf.measure.getSession().measurementCount;

    const full = dbg.exportProject();
    const fullSource = full.state.dxfPatternSource;
    await dbg.loadProject(full);
    const reopenedSession = dbg.dxf.measure.getSession();
    const reopened = {
      session: reopenedSession,
      sketchMode: dbg.getState().sketchMode,
      alongDisabled: document.getElementById('dxfMeasureAlongBtn').disabled,
      outDisabled: document.getElementById('dxfMeasureOutBtn').disabled,
    };

    dbg.autosave.flush();
    await new Promise(r => setTimeout(r, 120));
    const autosaveRecord = JSON.parse(dbg.autosave.peek());
    const autosaveSource = autosaveRecord.snapshot.state.dxfPatternSource;
    await dbg.loadProject(autosaveRecord.snapshot);
    const autosaveRestoredSession = dbg.dxf.measure.getSession();

    const legacy = dbg.exportProject();
    delete legacy.state.dxfPatternSource;
    await dbg.loadProject(legacy);
    const legacySession = dbg.dxf.measure.getSession();

    const mismatch = JSON.parse(JSON.stringify(full));
    mismatch.state.dxfPatternSource.fingerprint = 'fnv1a2-deadbeefdeadbeef-1';
    await dbg.loadProject(mismatch);
    const mismatchSession = dbg.dxf.measure.getSession();

    dbg.dxf.importText(${JSON.stringify(SQUARE_DXF)},
      { left: 0, top: 0, width: 1200, height: 800 }, 'remove-square.dxf');
    const removeGroup = dbg.dxf.patternPieces.groups().slice(-1)[0];
    dbg.dxf.patternPieces.remove([removeGroup.groupId]);
    const afterRemove = { source: dbg.dxf.source(), session: dbg.dxf.measure.getSession() };

    return {
      imported, temporaryCount,
      fullSource: fullSource && {
        fileName: fullSource.fileName,
        text: fullSource.text,
        fingerprint: fullSource.fingerprint,
        geometryFingerprint: fullSource.geometryFingerprint,
      },
      reopened,
      autosaveSource,
      autosaveRestoredSession,
      legacySession,
      mismatchSession,
      afterRemove,
    };
  })()`);

  check(result.imported && result.imported.ok, 'durable-source fixture imports successfully');
  check(result.temporaryCount === 1, 'pre-save session contains one real temporary measurement');
  check(result.fullSource && result.fullSource.fileName === 'durable-square.dxf'
    && result.fullSource.text === SQUARE_DXF
    && /^fnv1a2-/.test(result.fullSource.fingerprint)
    && /^fnv1a2-/.test(result.fullSource.geometryFingerprint),
  'Project JSON embeds a complete named, fingerprinted DXF Pattern Source');
  check(result.reopened.session && result.reopened.session.pieceCount === 1
    && result.reopened.session.measurementCount === 0,
  'Project reopen rebuilds native topology but not prior M1/M2');
  check(result.reopened.sketchMode === true && result.reopened.alongDisabled === false
    && result.reopened.outDisabled === false,
  'source-bearing reopen enters Sketch Focus with Along/Out enabled');
  check(result.autosaveSource && result.autosaveSource.text === null
    && result.autosaveSource.storage === 'indexeddb'
    && result.autosaveSource.fingerprint === result.fullSource.fingerprint,
  'localStorage autosave contains only the IndexedDB source reference: '
    + JSON.stringify(result.autosaveSource));
  check(result.autosaveRestoredSession && result.autosaveRestoredSession.pieceCount === 1
    && result.autosaveRestoredSession.measurementCount === 0,
  'autosave reference resolves from IndexedDB into a fresh empty native session');
  check(result.legacySession === null, 'legacy project without source remains loadable and fail-closed');
  check(result.mismatchSession === null, 'source fingerprint mismatch fails closed');
  check(result.afterRemove.source === null && result.afterRemove.session === null,
  'Remove invalidates both durable source and live measurement session');

  let factoryText = null;
  try { factoryText = await readFile(path.join(appDir, 'demo/DXF file/3380.dxf'), 'utf8'); }
  catch { /* public mirror may omit demo fixtures */ }
  if (factoryText) {
    const factory = await s.eval(`(async () => {
      const dbg = window.__braAutoModeDebug;
      const empty = dbg.exportProject();
      empty.state.annotations = [];
      delete empty.state.dxfPatternSource;
      await dbg.loadProject(empty);
      document.getElementById('modeManualBtn').click();
      if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
      const imported = dbg.dxf.importText(${JSON.stringify(factoryText)},
        { left: 0, top: 0, width: 1366, height: 900 }, '3380.dxf');
      const saved = dbg.exportProject();
      const started = performance.now();
      await dbg.loadProject(saved);
      const elapsedMs = performance.now() - started;
      return {
        imported,
        elapsedMs,
        sourceFile: dbg.dxf.source() && dbg.dxf.source().fileName,
        session: dbg.dxf.measure.getSession(),
        alongEnabled: !document.getElementById('dxfMeasureAlongBtn').disabled,
        outEnabled: !document.getElementById('dxfMeasureOutBtn').disabled,
      };
    })()`);
    check(factory.imported && factory.imported.pieceCount === 6
      && factory.imported.annotationCount === 1252,
    '3380 imports as the real 6-piece/1252-line project fixture');
    check(factory.sourceFile === '3380.dxf' && factory.session
      && factory.session.pieceCount === 6
      && factory.session.pieceSegmentCounts.reduce((sum, count) => sum + count, 0) === 1240
      && factory.session.measurementCount === 0,
    '3380 Project round-trip rebuilds all 1240 native segments with no M1/M2');
    check(factory.alongEnabled && factory.outEnabled,
    '3380 Project round-trip leaves Along Path and Out of Path enabled');
    check(Number.isFinite(factory.elapsedMs) && factory.elapsedMs < 2000,
    '3380 Project source rebuild completes within 2s, got ' + factory.elapsedMs + 'ms');
  }
  console.log('PASS  section 17 (ADR 0088 durable DXF source lifecycle)');
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

// ---- Section 8: INSERT/BLOCK native resolution + unit provenance/override --
// (ADR 0073, findings-dxf.md Findings 1+2.) Fully synthetic — must pass in
// the public mirror with no demo/ present.
async function section8InsertBlocksAndUnits(s) {
  const m = 'window.__braAutoModeDebug.dxf.measure';

  // 1. Translated INSERT: exact native line, exact endpoints, no Y-flip.
  const translated = await s.eval(`${m}.parseNative(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', [dxfLine(0, 0, 10, 0)])],
    [dxfInsert('P', 100, 50)],
  ))})`);
  check(translated.ok && translated.pieces.length === 1 && translated.pieces[0].segments.length === 1,
    'translated INSERT resolves to one native segment, got ' + JSON.stringify(translated.buckets));
  const tSeg = translated.pieces[0].segments[0];
  check(tSeg.kind === 'straight' && near(tSeg.a.x, 100) && near(tSeg.a.y, 50) && near(tSeg.b.x, 110) && near(tSeg.b.y, 50),
    'translated INSERT endpoints are exact, got ' + JSON.stringify(tSeg));

  // 2. Rotated 90deg INSERT.
  const rotated = await s.eval(`${m}.parseNative(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', [dxfLine(0, 0, 10, 0)])],
    [dxfInsert('P', 0, 0, { rot: 90 })],
  ))})`);
  const rSeg = rotated.pieces[0].segments[0];
  check(near(rSeg.b.x, 0, 1e-9) && near(rSeg.b.y, 10, 1e-9), '90deg-rotated INSERT maps (10,0) to (0,10), got ' + JSON.stringify(rSeg));

  // 3. Uniformly scaled ARC stays an exact arc: radius and analytic length scale by |s|.
  const scaledArc = await s.eval(`(() => {
    const parsed = ${m}.parseNative(${JSON.stringify(docWithBlocks(
      [dxfBlock('A', [dxfArc(0, 0, 10, 0, 180)])],
      [dxfInsert('A', 0, 0, { sx: 2, sy: 2 })],
    ))});
    const seg = parsed.pieces[0].segments[0];
    return { kind: seg.kind, radius: seg.radius, sweep: seg.sweep, length: ${m}.segmentLength(seg) };
  })()`);
  check(scaledArc.kind === 'arc' && near(scaledArc.radius, 20) && near(scaledArc.length, 20 * Math.PI, 1e-9),
    '2x-scaled half-circle arc stays analytic (r=20, len=20pi), got ' + JSON.stringify(scaledArc));

  // 4. Mirrored ARC (sx=-1): orientation flips (sweep negates), |length|
  // invariant, and the transformed start point drives the new start angle.
  const mirroredArc = await s.eval(`(() => {
    const parsed = ${m}.parseNative(${JSON.stringify(docWithBlocks(
      [dxfBlock('A', [dxfArc(0, 0, 10, 0, 90)])],
      [dxfInsert('A', 0, 0, { sx: -1, sy: 1 })],
    ))});
    const seg = parsed.pieces[0].segments[0];
    const start = { x: seg.center.x + seg.radius * Math.cos(seg.startAngle), y: seg.center.y + seg.radius * Math.sin(seg.startAngle) };
    const endAngle = seg.startAngle + seg.sweep;
    const end = { x: seg.center.x + seg.radius * Math.cos(endAngle), y: seg.center.y + seg.radius * Math.sin(endAngle) };
    return { sweep: seg.sweep, radius: seg.radius, start, end, length: ${m}.segmentLength(seg) };
  })()`);
  check(mirroredArc.sweep < 0 && near(Math.abs(mirroredArc.sweep), Math.PI / 2, 1e-9),
    'mirrored arc flips sweep sign, |sweep| unchanged, got ' + mirroredArc.sweep);
  check(near(mirroredArc.start.x, -10, 1e-9) && near(mirroredArc.start.y, 0, 1e-9)
    && near(mirroredArc.end.x, 0, 1e-9) && near(mirroredArc.end.y, 10, 1e-9),
    'mirrored arc endpoints are the mirrored originals, got ' + JSON.stringify(mirroredArc));
  check(near(mirroredArc.length, 10 * Math.PI / 2, 1e-9), 'mirror preserves arc length, got ' + mirroredArc.length);

  // 5. Mirrored full CIRCLE stays within the kernel's |sweep| <= 2pi contract.
  const mirroredCircle = await s.eval(`(() => {
    const parsed = ${m}.parseNative(${JSON.stringify(docWithBlocks(
      [dxfBlock('C', [dxfCircle(0, 0, 5)])],
      [dxfInsert('C', 50, 0, { sx: -3, sy: 3 })],
    ))});
    const seg = parsed.pieces[0].segments[0];
    return { sweepAbs: Math.abs(seg.sweep), radius: seg.radius, length: ${m}.segmentLength(seg), cx: seg.center.x };
  })()`);
  check(near(mirroredCircle.sweepAbs, 2 * Math.PI, 1e-9) && near(mirroredCircle.radius, 15)
    && near(mirroredCircle.length, 2 * Math.PI * 15, 1e-9) && near(mirroredCircle.cx, 50, 1e-9),
    'mirrored+scaled CIRCLE stays one analytic full-sweep arc, got ' + JSON.stringify(mirroredCircle));

  // 6. ADR 0069 instance boundary: two same-position INSERTs of one block
  // stay two pieces (a grading-nest must never fuse across instances).
  const twoInstances = await s.eval(`${m}.parseNative(${JSON.stringify(docWithBlocks(
    [dxfBlock('P', [dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10)])],
    [dxfInsert('P', 0, 0), dxfInsert('P', 0, 0)],
  ))})`);
  check(twoInstances.ok && twoInstances.pieces.length === 2
    && twoInstances.pieces.every(p => p.segments.length === 2),
    'two same-position instances stay two native pieces, got ' + (twoInstances.pieces && twoInstances.pieces.length));

  // 7. Nested INSERT inherits its parent's instance (one piece, both levels).
  const nested = await s.eval(`${m}.parseNative(${JSON.stringify(docWithBlocks(
    [dxfBlock('INNER', [dxfLine(0, 0, 10, 0)]),
     dxfBlock('OUTER', [dxfLine(10, 0, 10, 10), dxfInsert('INNER', 0, 0)]),
    ],
    [dxfInsert('OUTER', 0, 0)],
  ))})`);
  check(nested.ok && nested.pieces.length === 1 && nested.pieces[0].segments.length === 2,
    'nested INSERT resolves into ONE piece under the parent instance, got ' + JSON.stringify(nested.pieces && nested.pieces.map(p => p.segments.length)));

  // 7b. Stacked exact-duplicate edges (real factory shape — BiancaBra's
  // block 11_22_M traces one rectangle 4x) must not explode the route
  // search: duplicates collapse to one representative, refs on a dropped
  // copy remap (with t flipped on a reversed copy), and the measured length
  // counts the path ONCE.
  const dupLine = await s.eval(`${m}.enumerateRoutesRaw([
    {kind:'straight', a:{x:0,y:0}, b:{x:10,y:0}},
    {kind:'straight', a:{x:0,y:0}, b:{x:10,y:0}},
    {kind:'straight', a:{x:10,y:0}, b:{x:0,y:0}},
    {kind:'straight', a:{x:0,y:0}, b:{x:10,y:0}},
  ], {segIndex:1, t:0.1}, {segIndex:2, t:0.1}, 1e-4)`);
  check(dupLine.ok && dupLine.routes.length === 1 && near(dupLine.routes[0].length, 8, 1e-9),
    '4x-duplicated line measures once (A on copy #2, B on the REVERSED copy, t flipped: 0.1..0.9 of 10 = 8), got '
    + JSON.stringify({ ok: dupLine.ok, reason: dupLine.reason, len: dupLine.routes && dupLine.routes[0] && dupLine.routes[0].length }));
  const dupSquare = await s.eval(`(() => {
    const edge = (x1,y1,x2,y2) => ({kind:'straight', a:{x:x1,y:y1}, b:{x:x2,y:y2}});
    const square = [edge(0,0,10,0), edge(10,0,10,10), edge(10,10,0,10), edge(0,10,0,0)];
    const segs = [...square, ...square, ...square, ...square]; // 4 stacked copies, 16 segments
    return ${m}.enumerateRoutesRaw(segs, {segIndex:0, t:0.5}, {segIndex:2, t:0.5}, 1e-4);
  })()`);
  check(dupSquare.ok && dupSquare.routes.length === 2
    && near(dupSquare.routes[0].length + dupSquare.routes[1].length, 40, 1e-9),
    '4x-stacked square still yields exactly the 2 complementary loop routes summing to one perimeter, got '
    + JSON.stringify({ ok: dupSquare.ok, reason: dupSquare.reason, count: dupSquare.routes && dupSquare.routes.length }));
  // Guard the narrowness: two DIFFERENT arcs between the same endpoints (a
  // lens) are genuinely two paths and must both survive dedupe.
  const lensRoutes = await s.eval(`(() => {
    // Two mirror arcs sharing endpoints (0,0) and (10,0): bulge +1 and -1
    // semicircle-ish arcs via the real parser, then enumerate between their
    // midpoints — both distinct paths must survive dedupe (equal length,
    // DIFFERENT circles).
    const parsed = ${m}.parseNative(${JSON.stringify(doc([
      dxfLwpolyline([[0, 0, 1], [10, 0, 0]], false),
      dxfLwpolyline([[0, 0, -1], [10, 0, 0]], false),
    ]))});
    const segs = parsed.pieces[0].segments;
    return ${m}.enumerateRoutesRaw(segs, {segIndex:0, t:0.25}, {segIndex:1, t:0.75}, 1e-4);
  })()`);
  check(lensRoutes.ok && lensRoutes.routes.length === 2,
    'two equal-length but geometrically different arcs (a lens) both survive dedupe as 2 routes, got '
    + JSON.stringify({ ok: lensRoutes.ok, count: lensRoutes.routes && lensRoutes.routes.length, reason: lensRoutes.reason }));

  // 8. $INSUNITS through a real HEADER section.
  const mmDoc = await s.eval(`${m}.parseNative(${JSON.stringify(docWithHeader(
    [P(9, '$INSUNITS'), P(70, 4)], [dxfLine(0, 0, 10, 0)],
  ))})`);
  check(mmDoc.ok && near(mmDoc.unit, 1 / 25.4, 1e-12) && mmDoc.unitSource === 'dxf-header' && mmDoc.insunits === 4,
    '$INSUNITS=4 resolves as declared mm, got ' + JSON.stringify({ unit: mmDoc.unit, unitSource: mmDoc.unitSource }));
  const unitlessDoc = await s.eval(`${m}.parseNative(${JSON.stringify(docWithHeader(
    [P(9, '$INSUNITS'), P(70, 0)], [dxfLine(0, 0, 10, 0)],
  ))})`);
  check(unitlessDoc.ok && unitlessDoc.unit === 1 && unitlessDoc.unitSource === 'unsupported-explicit-unit'
    && unitlessDoc.unitDiagnostic && unitlessDoc.insunits === 0,
    '$INSUNITS=0 is the flagged unsupported-explicit case, never silently "from file", got ' + JSON.stringify({ unitSource: unitlessDoc.unitSource }));
  const noHeaderDoc = await s.eval(`${m}.parseNative(${JSON.stringify(doc([dxfLine(0, 0, 10, 0)]))})`);
  check(noHeaderDoc.unit === 1 && noHeaderDoc.unitSource === 'default-inch',
    'missing $INSUNITS stays the distinct default-inch case, got ' + noHeaderDoc.unitSource);

  // 9. Live end-to-end: import a BLOCK-based DXF through the real file input
  // (the Finding-1 repro shape), then exercise the unit override through the
  // real #dxfMeasureUnitSelect (Finding 2).
  const BLOCK_CHAIN_DXF = docWithBlocks(
    [dxfBlock('PIECE', [dxfLine(0, 0, 40, 0)])],
    [dxfInsert('PIECE', 0, 0)],
  );
  const live = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const fire = (type, x, y) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(BLOCK_CHAIN_DXF)}], 'block.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    // Earlier sections' chooser toasts can still be draining through
    // toast.js's fair-reading queue — the import toast queues behind them
    // rather than replacing. Poll until IT is the one displayed.
    let toastAfterImport = '';
    for (let i = 0; i < 100; i += 1) {
      const t = document.querySelector('.toast');
      toastAfterImport = t ? t.textContent : '';
      if (toastAfterImport.indexOf('Imported') !== -1) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const sessionAfterImport = dbg.dxf.measure.getSession();

    // A real Along Path measurement on the single resolved segment.
    document.getElementById('toolsMenuBtn').click();
    document.getElementById('dxfMeasureAlongBtn').click();
    const ann = dbg.getAnnotations().slice(-1)[0];
    const view = dbg.getView();
    const rect = canvas.getBoundingClientRect();
    const toScreen = (w) => ({ x: rect.left + w.x * view.zoom + view.panX, y: rect.top + w.y * view.zoom + view.panY });
    const lerp = (t) => ({ x: ann.start.x + (ann.end.x - ann.start.x) * t, y: ann.start.y + (ann.end.y - ann.start.y) * t });
    const pA = toScreen(lerp(0.1)), pB = toScreen(lerp(0.9));
    fire('mousedown', pA.x, pA.y); fire('mouseup', pA.x, pA.y);
    fire('mousedown', pB.x, pB.y); fire('mouseup', pB.x, pB.y);
    // A route/direction chooser may open even on an unambiguous path
    // (direction is a TD choice); Enter confirms the default candidate.
    const pending = dbg.dxf.measure.getSession().interaction;
    if (pending && (pending.type === 'choosing-route' || pending.type === 'choosing-entity')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    const sessionAfterMeasure = dbg.dxf.measure.getSession();
    const measureDiag = {
      interaction: sessionAfterMeasure.interaction && sessionAfterMeasure.interaction.type,
      count: sessionAfterMeasure.measurementCount,
      tool: dbg.getState().tool,
      toastNow: document.querySelector('.toast') ? document.querySelector('.toast').textContent : '',
      ann: { start: ann.start, end: ann.end },
      pA, pB, view, rect: { left: rect.left, top: rect.top, w: rect.width, h: rect.height },
    };
    const measurementId = sessionAfterMeasure.measurements.length ? sessionAfterMeasure.measurements[0].id : null;
    const valueBeforeOverride = measurementId != null ? dbg.dxf.measure.valueInches(measurementId) : null;

    const select = document.getElementById('dxfMeasureUnitSelect');
    const selectDisabled = select.disabled;
    select.value = 'mm';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const sessionAfterOverride = dbg.dxf.measure.getSession();
    const valueAfterOverride = measurementId != null ? dbg.dxf.measure.valueInches(measurementId) : null;
    const noteText = document.getElementById('dxfMeasureUnitNote').textContent;
    const selectValueAfter = select.value;

    // Back to a fresh state for anything after this section.
    dbg.dxf.measure.setUnitOverride(null);
    return {
      toastAfterImport,
      sessionNull: sessionAfterImport === null,
      pieceCount: sessionAfterImport && sessionAfterImport.pieceCount,
      unitStatusBefore: sessionAfterImport && sessionAfterImport.unitStatus,
      measurementCount: sessionAfterMeasure.measurementCount,
      measureDiag,
      valueBeforeOverride, valueAfterOverride,
      toleranceBefore: sessionAfterImport && sessionAfterImport.topologyToleranceNative,
      toleranceAfter: sessionAfterOverride.topologyToleranceNative,
      unitStatusAfter: sessionAfterOverride.unitStatus,
      unitOverrideAfter: sessionAfterOverride.unitOverride,
      selectDisabled, selectValueAfter, noteText,
    };
  })()`);
  check(live.sessionNull === false && live.pieceCount === 1,
    'Finding 1: a BLOCK/INSERT-only DXF now builds a live measure session, got ' + JSON.stringify({ sessionNull: live.sessionNull, pieceCount: live.pieceCount }));
  check(String(live.toastAfterImport).includes('Units assumed'),
    'import toast carries the assumed-units warning, got "' + live.toastAfterImport + '"');
  check(live.unitStatusBefore && live.unitStatusBefore.key === 'in' && String(live.unitStatusBefore.provenance).includes('didn'),
    'pre-override unit status is the flagged inch assumption, got ' + JSON.stringify(live.unitStatusBefore));
  check(live.measurementCount === 1 && near(live.valueBeforeOverride, 32, 1.5),
    'Along Path on the resolved block segment measures ~32 native units as inches, got ' + live.valueBeforeOverride
    + ' diag=' + JSON.stringify(live.measureDiag));
  check(near(live.valueBeforeOverride / live.valueAfterOverride, 25.4, 1e-6),
    'mm override rescales every displayed value by exactly 25.4, got ratio ' + (live.valueBeforeOverride / live.valueAfterOverride));
  check(near(live.toleranceBefore, 0.01 / 25.4, 1e-15) && near(live.toleranceAfter, 0.01, 1e-12),
    'mm override recomputes the RB-4 topology tolerance (0.01mm in native units), got ' + live.toleranceBefore + ' -> ' + live.toleranceAfter);
  check(live.unitOverrideAfter === 'mm' && live.unitStatusAfter && live.unitStatusAfter.key === 'mm'
    && live.unitStatusAfter.provenance === 'set by you',
    'override provenance is "set by you", got ' + JSON.stringify(live.unitStatusAfter));
  check(live.selectDisabled === false && live.selectValueAfter === 'mm' && live.noteText === 'mm — set by you',
    'the real select/note reflect the override, got ' + JSON.stringify({ d: live.selectDisabled, v: live.selectValueAfter, n: live.noteText }));
  console.log('PASS  section 8 (INSERT/BLOCK native resolution + unit provenance/override)');
}

// ---- Section 9: piece edit invalidation (findings-dxf.md Finding 7) --------
// Removing or Simplifying a piece from the Pattern Pieces panel must never
// leave the measure session pointing at deleted or renumbered board
// geometry — it must invalidate (session -> null), not go stale.
async function section9PieceEditInvalidation(s) {
  // Two independent pieces: a plain 2-segment corner (left alone) and a
  // 4-collinear-segment run (Simplify merges it into 1, changing its
  // annotation id — exactly the case that used to detach the session).
  const TWO_PIECE_DXF = doc([
    dxfLine(0, 0, 0, 50), dxfLine(0, 50, 50, 50),
    dxfLine(1000, 0, 1100, 0), dxfLine(1100, 0, 1200, 0), dxfLine(1200, 0, 1300, 0), dxfLine(1300, 0, 1400, 0),
  ]);

  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    // This section runs after 5 prior sections' own imports/fixtures, all
    // additive in this one continuous browser session — a bare board reset
    // (empty annotations/images) is required so the count-based row lookups
    // below can't collide with leftover pieces of the same segment count.
    const resetBoard = async () => {
      const p = dbg.exportProject();
      p.state.annotations = []; p.state.images = [];
      await dbg.loadProject(p);
      document.getElementById('modeManualBtn').click();
      if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    };
    const importFixture = async (text) => {
      document.getElementById('toolsMenuBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const input = document.getElementById('projectFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'twopiece.dxf', { type: 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    };
    const openPanelAndFindRow = (predicate) => {
      dbg.dxf.patternPieces.open();
      const rows = Array.from(document.querySelectorAll('#patternPiecesBody .pattern-piece-row'));
      return rows.find(predicate);
    };

    // --- Simplify invalidates ---
    await resetBoard();
    await importFixture(${JSON.stringify(TWO_PIECE_DXF)});
    const sessionBeforeSimplify = dbg.dxf.measure.getSession();
    const groupsBeforeSimplify = dbg.dxf.patternPieces.groups();
    const annsBeforeSimplify = dbg.getAnnotations().length;
    const runRow = openPanelAndFindRow(r => parseInt(r.querySelector('.pattern-piece-count').textContent, 10) === 4);
    const simplifyBtn = runRow ? Array.from(runRow.querySelectorAll('.pattern-piece-mini-btn')).find(b => b.textContent === 'Simplify') : null;
    if (simplifyBtn) simplifyBtn.click();
    const sessionAfterSimplify = dbg.dxf.measure.getSession();
    const annsAfterSimplify = dbg.getAnnotations().length;
    // Earlier sections' own toasts may still be draining through toast.js's
    // fair-reading queue (TOAST_MIN_VISIBLE_MS=900) — poll until THIS click's
    // own toast is the one displayed, same discipline as section 8.
    let toastAfterSimplify = '';
    for (let i = 0; i < 30; i += 1) {
      const t = document.querySelector('.toast');
      toastAfterSimplify = t ? t.textContent : '';
      if (toastAfterSimplify.indexOf('Pattern Measure cleared') !== -1 || toastAfterSimplify.indexOf('Simplified') !== -1) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // --- Remove unchecked invalidates ---
    await resetBoard();
    await importFixture(${JSON.stringify(TWO_PIECE_DXF)});
    const sessionBeforeRemove = dbg.dxf.measure.getSession();
    const rowToRemove = openPanelAndFindRow(r => parseInt(r.querySelector('.pattern-piece-count').textContent, 10) === 4);
    rowToRemove.querySelector('.pattern-piece-checkbox').click();
    document.getElementById('patternPiecesApplyBtn').click();
    const sessionAfterRemove = dbg.dxf.measure.getSession();
    let toastAfterRemove = '';
    for (let i = 0; i < 20; i += 1) {
      const t = document.querySelector('.toast');
      toastAfterRemove = t ? t.textContent : '';
      if (toastAfterRemove.indexOf('Pattern Measure cleared') !== -1) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // --- Control: removing a piece with NO active session stays quiet ---
    await resetBoard();
    await importFixture(${JSON.stringify(TWO_PIECE_DXF)});
    // Switch to Auto Mode and back to Manual to clear the session (US-105's
    // existing mode-switch reset) before touching Pattern Pieces again.
    document.getElementById('modeAutoBtn').click();
    document.getElementById('modeManualBtn').click();
    const sessionAlreadyNull = dbg.dxf.measure.getSession();
    const quietRow = openPanelAndFindRow(r => parseInt(r.querySelector('.pattern-piece-count').textContent, 10) === 2);
    quietRow.querySelector('.pattern-piece-checkbox').click();
    document.getElementById('patternPiecesApplyBtn').click();
    let toastAfterQuietRemove = '';
    for (let i = 0; i < 30; i += 1) {
      const t = document.querySelector('.toast');
      toastAfterQuietRemove = t ? t.textContent : '';
      if (toastAfterQuietRemove.indexOf('Removed') !== -1) break;
      await new Promise(r => setTimeout(r, 100));
    }

    return {
      sessionBeforeSimplify: !!sessionBeforeSimplify, sessionAfterSimplify, toastAfterSimplify,
      groupsBeforeSimplify, annsBeforeSimplify, annsAfterSimplify, foundRunRow: !!runRow, foundSimplifyBtn: !!simplifyBtn,
      sessionBeforeRemove: !!sessionBeforeRemove, sessionAfterRemove, toastAfterRemove,
      sessionAlreadyNull, toastAfterQuietRemove,
    };
  })()`);

  check(result.sessionBeforeSimplify === true, 'a fresh 2-piece import has a live measure session before Simplify');
  check(result.sessionAfterSimplify === null, 'Simplify invalidates the measure session, got ' + JSON.stringify(result.sessionAfterSimplify)
    + ' diag=' + JSON.stringify({ groups: result.groupsBeforeSimplify, annsBefore: result.annsBeforeSimplify, annsAfter: result.annsAfterSimplify, foundRunRow: result.foundRunRow, foundSimplifyBtn: result.foundSimplifyBtn }));
  check(result.toastAfterSimplify.indexOf('Pattern Measure cleared') !== -1, 'Simplify shows the invalidation toast, got "' + result.toastAfterSimplify + '"');
  check(result.sessionBeforeRemove === true, 'a fresh 2-piece import has a live measure session before Remove');
  check(result.sessionAfterRemove === null, 'Remove unchecked invalidates the measure session, got ' + JSON.stringify(result.sessionAfterRemove));
  check(result.toastAfterRemove.indexOf('Pattern Measure cleared') !== -1, 'Remove unchecked shows the invalidation toast, got "' + result.toastAfterRemove + '"');
  check(result.sessionAlreadyNull === null, 'control: mode-switch already cleared the session before this Remove');
  check(result.toastAfterQuietRemove.indexOf('Pattern Measure cleared') === -1, 'control: removing a piece with no active session stays quiet, got "' + result.toastAfterQuietRemove + '"');
  console.log('PASS  section 9 (piece-edit invalidation — Finding 7)');
}

// ---- Section 10: US-112 snap modes ------------------------------------------
// Endpoint/midpoint/intersection snap for Pattern Measure. 10.1 is pure
// kernel math (no import, no session — same "isolate the math" contract as
// section 1/8). 10.2 drives the REAL Out of Path placement flow through real
// mousedown/mouseup events to prove snap actually changes what gets
// committed (and that Alt/Option and the menu toggles bypass it), using Out
// of Path specifically because its endpoint resolution
// (dxfMeasureOutOfPathEndpointFromBoard) has no entity-ambiguity step to
// route around — a corner shared by two segments would otherwise need the
// same Tab/Enter choosing-entity dance section 6 already covers, which is
// not what this section exists to prove. 10.3 is the perf guard named in the
// story plan: per-piece snap index build must stay off the pointermove hot
// path (lazy + cached), checked against the real six-piece factory fixture.
async function section10Snap(s) {
  // 10.1 — pure kernel math, no DXF parse/import at all.
  const pure = await s.eval(`(() => {
    const m = window.__braAutoModeDebug.dxf.measure;
    // A 10x10 square (4 straight segments, closed) plus one internal
    // vertical LINE at x=5 spanning y=-3..13 — crosses the bottom edge
    // (y=0) and top edge (y=10) at interior points (t=0.5 on each edge),
    // and is parallel to (so never crosses) the two vertical sides.
    const square = [
      { kind: 'straight', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },   // 0: bottom
      { kind: 'straight', a: { x: 10, y: 0 }, b: { x: 10, y: 10 } }, // 1: right
      { kind: 'straight', a: { x: 10, y: 10 }, b: { x: 0, y: 10 } }, // 2: top
      { kind: 'straight', a: { x: 0, y: 10 }, b: { x: 0, y: 0 } },   // 3: left
    ];
    const withDart = square.concat([{ kind: 'straight', a: { x: 5, y: -3 }, b: { x: 5, y: 13 } }]); // 4: dart
    const squareIndex = m.buildSnapIndexForSegments(square, 1e-6);
    const dartIntersections = m.buildIntersectionsForSegments(withDart);
    // Pure line x arc: a horizontal line through a half-circle's center.
    const lineSeg = { kind: 'straight', a: { x: -20, y: 0 }, b: { x: 20, y: 0 } };
    const arcSeg = { kind: 'arc', center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweep: Math.PI }; // upper half only
    const hits = m.lineArcIntersections(lineSeg, arcSeg);
    const noHits = m.lineArcIntersections({ kind: 'straight', a: { x: -20, y: 50 }, b: { x: 20, y: 50 } }, arcSeg);
    return { squareIndex, dartIntersections, hits, noHits };
  })()`);
  check(pure.squareIndex.endpoints.length === 4, 'a closed 4-segment square clusters into exactly 4 endpoint (corner) snap points, got ' + pure.squareIndex.endpoints.length);
  check(pure.squareIndex.endpoints.every(e => e.refs.length === 2), 'every square corner is shared by exactly 2 segments, got ' + JSON.stringify(pure.squareIndex.endpoints.map(e => e.refs.length)));
  check(pure.squareIndex.midpoints.length === 4 && pure.squareIndex.midpoints.every(mp => mp.refs.length === 1),
    'one unclustered midpoint per segment, got ' + JSON.stringify(pure.squareIndex.midpoints));
  check(near(pure.squareIndex.midpoints[0].native.x, 5) && near(pure.squareIndex.midpoints[0].native.y, 0),
    'bottom edge midpoint is exactly (5,0), got ' + JSON.stringify(pure.squareIndex.midpoints[0].native));
  check(pure.dartIntersections.length === 2, 'the dart line crosses exactly 2 edges (bottom+top), not the 2 parallel sides or its own endpoints, got '
    + JSON.stringify(pure.dartIntersections));
  const dartPoints = pure.dartIntersections.map(x => x.native).sort((a, b) => a.y - b.y);
  check(near(dartPoints[0].x, 5) && near(dartPoints[0].y, 0) && near(dartPoints[1].x, 5) && near(dartPoints[1].y, 10),
    'dart intersections land exactly at (5,0) and (5,10), got ' + JSON.stringify(dartPoints));
  check(pure.hits.length === 2 && pure.hits.every(h => near(Math.hypot(h.point.x, h.point.y), 10)),
    'a line through a circle its center yields 2 points exactly on the radius, got ' + JSON.stringify(pure.hits));
  check(pure.noHits.length === 0, 'a line entirely outside the circle (and outside the arc\'s own half-plane) yields no intersections, got ' + JSON.stringify(pure.noHits));
  console.log('PASS  section 10.1 (snap index + intersection math, pure)');

  // 10.2 — real Out of Path placement, snapped vs Alt-bypassed vs toggled off.
  const SNAP_SQUARE_DXF = doc([dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]);
  const live = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(SNAP_SQUARE_DXF)}], 'snapsquare.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));

    const canvas = document.getElementById('boardCanvas');
    const settle = (frames=2) => new Promise(resolve => { const step = () => frames-- <= 0 ? resolve() : requestAnimationFrame(step); requestAnimationFrame(step); });
    const toScreen = world => { const rect = canvas.getBoundingClientRect(), view = dbg.getView(); return { x: rect.left + world.x * view.zoom + view.panX, y: rect.top + world.y * view.zoom + view.panY }; };
    const fireWorld = (type, world, extra={}) => { const p = toScreen(world); canvas.dispatchEvent(new MouseEvent(type, Object.assign({clientX:p.x,clientY:p.y,bubbles:true,button:0}, extra))); };
    const clickWorld = async (world, extra={}) => { fireWorld('mousedown', world, extra); fireWorld('mouseup', world, extra); await settle(1); };
    const pointB = dbg.dxf.measure.nativeToBoardLive({ x: 5, y: 5 }, 0);
    // US-112: this section does not trust incoming toggle state (an earlier
    // section may have changed it — see section 6's own comment) — force the
    // exact endpoint/midpoint state each step needs before asserting on it.
    const setSnap = (endpoint, midpoint) => {
      const current = dbg.dxf.measure.snapEnabled();
      if (current.endpoint !== endpoint) document.getElementById('dxfMeasureSnapEndpointBtn').click();
      if (current.midpoint !== midpoint) document.getElementById('dxfMeasureSnapMidpointBtn').click();
    };

    // Point 6 screen px up-left of native corner (0,0), diagonally outside the square.
    const corner = dbg.dxf.measure.nativeToBoardLive({ x: 0, y: 0 }, 0);
    const zoom = dbg.getView().zoom, off = 6 / zoom / Math.SQRT2;
    const near = { x: corner.x - off, y: corner.y - off };

    const placeOutOfPath = async (extra={}) => {
      document.getElementById('dxfMeasureOutBtn').click();
      await clickWorld(near, extra);
      await clickWorld(pointB, {});
      const session = dbg.dxf.measure.getSession();
      const m = session.measurements[session.measurements.length - 1];
      return m ? m.a.native : null;
    };

    setSnap(true, true);
    const snapped = await placeOutOfPath();
    const altBypassed = await placeOutOfPath({ altKey: true });
    setSnap(false, false);
    const toggledOff = await placeOutOfPath();
    setSnap(true, true); // restore defaults for whatever runs after this section
    const restoredSnap = dbg.dxf.measure.snapEnabled();
    document.getElementById('toolSelect').click();
    return { snapped, altBypassed, toggledOff, restoredSnap, cornerNative: { x: 0, y: 0 } };
  })()`);
  const distTo00 = p => Math.hypot(p.x, p.y);
  check(distTo00(live.snapped) < 1e-6, 'a click 6px from the corner snaps exactly onto it when Endpoint snap is on, got ' + JSON.stringify(live.snapped));
  check(distTo00(live.altBypassed) > 1e-3, 'Alt/Option bypasses snap for that one click, got ' + JSON.stringify(live.altBypassed));
  check(distTo00(live.toggledOff) > 1e-3, 'turning Endpoint snap off restores the unsnapped click, got ' + JSON.stringify(live.toggledOff));
  check(near(live.altBypassed.x, live.toggledOff.x, 1e-6) && near(live.altBypassed.y, live.toggledOff.y, 1e-6),
    'Alt-bypass and toggle-off resolve the SAME raw click to the same native point (both skip snap, neither invents a different unsnapped answer), got '
    + JSON.stringify({ altBypassed: live.altBypassed, toggledOff: live.toggledOff }));
  check(live.restoredSnap.endpoint === true && live.restoredSnap.midpoint === true, 'snap toggles are restored to their defaults for later sections, got ' + JSON.stringify(live.restoredSnap));
  console.log('PASS  section 10.2 (real Out of Path placement: snapped / Alt-bypassed / toggled off)');

  // 10.3 — perf guard: snap must not turn pointermove into an O(n^2)-per-frame
  // scan. Real 6-piece fixture, all three kinds enabled (worst case, forces
  // the lazy intersection index to build for every piece the sweep visits).
  let fixtureText;
  try {
    fixtureText = await readFile(path.join(appDir, 'demo/DXF file/3380.dxf'), 'utf8');
  } catch {
    console.log('SKIP  dxf-measurement-check   demo/DXF file/3380.dxf not present (public mirror) — section 10.3 skipped');
    return;
  }
  const perf = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(fixtureText)}], '3380.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40; i += 1) await new Promise(r => requestAnimationFrame(r));

    // US-112: force ALL THREE kinds on (worst case for the lazy-build cost
    // this guards), not trusting whatever an earlier section left behind.
    const setSnap3 = (endpoint, midpoint, intersection) => {
      const current = dbg.dxf.measure.snapEnabled();
      if (current.endpoint !== endpoint) document.getElementById('dxfMeasureSnapEndpointBtn').click();
      if (current.midpoint !== midpoint) document.getElementById('dxfMeasureSnapMidpointBtn').click();
      if (current.intersection !== intersection) document.getElementById('dxfMeasureSnapIntersectionBtn').click();
    };
    setSnap3(true, true, true);
    document.getElementById('dxfMeasureAlongBtn').click(); // arms pattern-measure, so mousemove drives the hover snap lookup
    const canvas = document.getElementById('boardCanvas'), rect = canvas.getBoundingClientRect();
    const dispatchMove = (x, y) => canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: rect.left + x, clientY: rect.top + y, bubbles: true }));
    const N = 300;
    const t0 = performance.now();
    for (let i = 0; i < N; i += 1) dispatchMove((i * 37) % Math.max(1, rect.width), (i * 53) % Math.max(1, rect.height));
    const elapsedMs = performance.now() - t0;
    setSnap3(true, true, false); // restore defaults (Intersection is opt-in)
    document.getElementById('toolSelect').click();
    return { elapsedMs, perCallMs: elapsedMs / N, pieceCount: dbg.dxf.measure.getSession().pieceCount };
  })()`);
  check(perf.pieceCount === 6, 'perf guard ran against the real 6-piece fixture, got ' + perf.pieceCount + ' pieces');
  // Generous by design (this proves "not accidentally quadratic per frame",
  // not a tight ms budget) — a real regression to O(pieces * segments^2) per
  // mousemove would blow through this by one or two orders of magnitude, not
  // by a hair, so no `log()`-worthy silent tolerance-widening risk here.
  check(perf.perCallMs < 8, '300 hover mousemoves over the 6-piece fixture with all 3 snap kinds on average under 8ms/call, got '
    + perf.perCallMs.toFixed(3) + 'ms/call (total ' + perf.elapsedMs.toFixed(1) + 'ms)');
  console.log('PASS  section 10.3 (snap perf guard on the real 6-piece fixture): ' + perf.perCallMs.toFixed(3) + 'ms/call');

  // 10.4 — ADR 0077's own regression guard: 10.3's 6-piece fixture (3380.dxf)
  // is far too small to have ever exercised the bug ADR 0077 fixed
  // (dxfMeasureCurrentPieceOffset's O(n)-in-state.annotations cost, paid
  // once per SNAP POINT instead of once per piece — invisible until a file
  // has enough pieces/annotations to make that multiplier matter). Calls
  // dbg.dxf.measure.snapCandidates(world) DIRECTLY in a tight loop rather
  // than dispatching mousemove and hoping a render happens in between (the
  // mousemove handler only records hoverWorld; the actual snap lookup runs
  // inside the CANVAS PAINT, drawDxfMeasureSnapHover — a real risk in any
  // headless/backgrounded context where rAF may be throttled or never fire,
  // see [[browser-pane-visibilitystate-hidden]]) — this calls the exact
  // function ADR 0077 fixed, directly, so the result is never in question.
  let largeFixtureText;
  try {
    largeFixtureText = await readFile(path.join(appDir, 'demo/DXF file/BiancaBra v.A 1.0_Pattern.dxf'), 'utf8');
  } catch {
    console.log('SKIP  dxf-measurement-check   demo/DXF file/BiancaBra v.A 1.0_Pattern.dxf not present (public mirror) — section 10.4 skipped');
    return;
  }
  const largePerf = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(largeFixtureText)}], 'bianca.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40; i += 1) await new Promise(r => requestAnimationFrame(r));

    const setSnap3 = (endpoint, midpoint, intersection) => {
      const current = dbg.dxf.measure.snapEnabled();
      if (current.endpoint !== endpoint) document.getElementById('dxfMeasureSnapEndpointBtn').click();
      if (current.midpoint !== midpoint) document.getElementById('dxfMeasureSnapMidpointBtn').click();
      if (current.intersection !== intersection) document.getElementById('dxfMeasureSnapIntersectionBtn').click();
    };
    setSnap3(true, true, true);
    const N = 15;
    const worldPoints = Array.from({length: N}, (_, i) => ({ x: (i * 137) % 2000, y: (i * 211) % 2000 }));
    // The FIRST call pays a real, expected one-time cost (building every
    // piece's lazy snap+intersection index) — timed separately so a single
    // warm-up outlier can never masquerade as steady-state per-call cost,
    // and never accidentally hide a regression by diluting it into an
    // average over just 15 samples.
    const warmup0 = performance.now();
    dbg.dxf.measure.snapCandidates(worldPoints[0]);
    const warmupMs = performance.now() - warmup0;
    const t0 = performance.now();
    for (let i = 1; i < N; i += 1) dbg.dxf.measure.snapCandidates(worldPoints[i]);
    const elapsedMs = performance.now() - t0;
    setSnap3(true, true, false);
    document.getElementById('toolSelect').click();
    return { warmupMs, elapsedMs, perCallMs: elapsedMs / (N - 1), pieceCount: dbg.dxf.measure.getSession().pieceCount };
  })()`);
  check(largePerf.pieceCount > 50, 'perf guard ran against the large real fixture (100+ pieces), got ' + largePerf.pieceCount + ' pieces');
  // The regression this guards: measured ~525-611ms/call interactively, and
  // ~40ms/call in this same headless harness with just ONE of ADR 0077's
  // three hoisted call sites reverted (mutation-tested) — the fixed
  // steady-state measures ~1-2ms/call here, so 15ms leaves ample margin
  // above real variance while still catching that mutation cleanly (a 50ms
  // threshold measured too close to the 40ms reverted case in this
  // environment to be a reliable guard).
  check(largePerf.perCallMs < 15, 'steady-state snapCandidates() on the ' + largePerf.pieceCount + '-piece/21000+-annotation fixture stays under 15ms/call after the one-time index warm-up, got '
    + largePerf.perCallMs.toFixed(3) + 'ms/call (warm-up call alone: ' + largePerf.warmupMs.toFixed(1) + 'ms)');
  console.log('PASS  section 10.4 (large-file snap perf guard, ADR 0077): ' + largePerf.perCallMs.toFixed(3) + 'ms/call steady-state');
}

// ---- Section 11: US-113 measurements list panel -----------------------------
// The panel is a pure VIEW over state.dxfMeasureSession.measurements — every
// assertion here compares the RENDERED DOM against the session read through
// the debug hook (never the DOM against itself), per this file's own
// no-tautology convention (see US-083's "a contract asserting the drafter's
// own formula can never fail" lesson).
async function section11MeasurementsPanel(s) {
  const PANEL_SQUARE_DXF = doc([dxfLine(0, 0, 20, 0), dxfLine(20, 0, 20, 20), dxfLine(20, 20, 0, 20), dxfLine(0, 20, 0, 0)]);
  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(PANEL_SQUARE_DXF)}], 'panelsquare.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));

    const canvas = document.getElementById('boardCanvas');
    const settle = (frames=2) => new Promise(resolve => { const step = () => frames-- <= 0 ? resolve() : requestAnimationFrame(step); requestAnimationFrame(step); });
    const toScreen = world => { const rect = canvas.getBoundingClientRect(), view = dbg.getView(); return { x: rect.left + world.x * view.zoom + view.panX, y: rect.top + world.y * view.zoom + view.panY }; };
    const fireWorld = (type, world) => { const p = toScreen(world); canvas.dispatchEvent(new MouseEvent(type, {clientX:p.x,clientY:p.y,bubbles:true,button:0})); };
    const clickWorld = async world => { fireWorld('mousedown', world); fireWorld('mouseup', world); await settle(1); };
    const placeOutOfPath = async (a, b) => {
      document.getElementById('dxfMeasureOutBtn').click();
      await clickWorld(dbg.dxf.measure.nativeToBoardLive(a, 0));
      await clickWorld(dbg.dxf.measure.nativeToBoardLive(b, 0));
    };

    // Three measurements with distinct, independently-known native lengths.
    await placeOutOfPath({ x: 2, y: 2 }, { x: 2, y: 5 });   // length 3
    await placeOutOfPath({ x: 2, y: 2 }, { x: 6, y: 2 });   // length 4
    await placeOutOfPath({ x: 2, y: 2 }, { x: 5, y: 6 });   // length 5 (3-4-5)
    const sessionAfterCreate = dbg.dxf.measure.getSession();
    const idsInCreationOrder = sessionAfterCreate.measurements.map(m => m.id);
    // Independently-known-length oracle values, read through the debug hook
    // (never the DOM), for comparison against what the panel actually shows.
    const expectedValues = idsInCreationOrder.map(id => dbg.dxf.measure.valueInches(id));
    const expectedFormatted = expectedValues.map(v => dbg.dxf.measure.formatInches(v));

    document.getElementById('dxfMeasurementsListBtn').click();
    await settle(1);
    const panelOpenAfterClick = !document.getElementById('dxfMeasurementsPanel').hidden;
    const rowsAfterCreate = Array.from(document.querySelectorAll('#dxfMeasurementsBody .dxf-measurement-row'))
      .map(row => ({ name: row.querySelector('.dxf-measurement-name').textContent, value: row.querySelector('.dxf-measurement-value').textContent }));

    // --- rename: dblclick -> set value -> blur (commit-on-blur convention) ---
    const firstRow = document.querySelector('#dxfMeasurementsBody .dxf-measurement-row');
    firstRow.querySelector('.dxf-measurement-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const nameInput = firstRow.querySelector('.dxf-measurement-name-input');
    const inputAppearedOnDblclick = !!nameInput;
    nameInput.value = 'CF length';
    // Real .blur() (not a synthetic 'blur' Event) — the panel's own
    // "don't rebuild while this input is document.activeElement" guard reads
    // document.activeElement, which only a genuine focus change updates.
    nameInput.blur();
    await settle(1);
    const nameAfterRename = dbg.dxf.measure.getSession().measurements[0].name;
    const rowNameAfterRename = document.querySelector('#dxfMeasurementsBody .dxf-measurement-row .dxf-measurement-name').textContent;

    dbg.dxf.measure.undo();
    const nameAfterUndo = dbg.dxf.measure.getSession().measurements[0].name;
    dbg.dxf.measure.redo();
    const nameAfterRedo = dbg.dxf.measure.getSession().measurements[0].name;

    // --- Escape reverts locally without a no-op history entry ---
    // The rename commit above triggered updateUI() -> a full panel rebuild
    // (fingerprint changed), so firstRow (captured before that rebuild) is
    // now a DETACHED node — re-query the live row-0 rather than reuse it.
    const historyBeforeEscape = dbg.dxf.measure.getSession().historyPast;
    const liveFirstRow = document.querySelector('#dxfMeasurementsBody .dxf-measurement-row');
    liveFirstRow.querySelector('.dxf-measurement-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const escapeInput = liveFirstRow.querySelector('.dxf-measurement-name-input');
    escapeInput.value = 'should not stick';
    escapeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const nameAfterEscape = dbg.dxf.measure.getSession().measurements[0].name;
    const inputGoneAfterEscape = !liveFirstRow.querySelector('.dxf-measurement-name-input');
    const historyAfterEscape = dbg.dxf.measure.getSession().historyPast;

    // --- row click selects; ✕ deletes exactly that row ---
    // Selecting a row changes session.selectedMeasurementId, which is part of
    // this panel's own render fingerprint (dxfMeasurementsFingerprint) — so
    // the click below triggers a FULL rebuild via updateUI(), and any row
    // reference captured before it goes stale. Re-query fresh after every
    // action that can trigger one, rather than trust a held reference.
    const rowsAt = () => Array.from(document.querySelectorAll('#dxfMeasurementsBody .dxf-measurement-row'));
    rowsAt()[1].click();
    await settle(1);
    const selectedAfterRowClick = dbg.dxf.measure.getSession().selectedMeasurementId;
    const activeRowClassAfterClick = rowsAt()[1].className.includes('active');
    const deleteBtn = Array.from(rowsAt()[2].querySelectorAll('.pattern-piece-mini-btn')).find(b => b.textContent === '✕');
    deleteBtn.click();
    await settle(1);
    const idsAfterDelete = dbg.dxf.measure.getSession().measurements.map(m => m.id);
    const rowCountAfterDelete = document.querySelectorAll('#dxfMeasurementsBody .dxf-measurement-row').length;

    // --- Clear all: one history step, panel goes to its empty state ---
    document.getElementById('dxfMeasurementsClearAllBtn').click();
    await settle(1);
    const countAfterClearAll = dbg.dxf.measure.getSession().measurementCount;
    const emptyStateText = document.querySelector('#dxfMeasurementsBody .dxf-measurement-row').textContent;
    dbg.dxf.measure.undo();
    const countAfterClearAllUndo = dbg.dxf.measure.getSession().measurementCount;

    // --- serializer guard: name never leaves the session ---
    const projectJson = JSON.stringify(dbg.exportProject());
    const autosave = dbg.autosave.peek() || '';

    document.getElementById('dxfMeasurementsCloseBtn').click();
    const panelHiddenAfterClose = document.getElementById('dxfMeasurementsPanel').hidden;
    document.getElementById('toolSelect').click();

    return {
      idsInCreationOrder, expectedValues, expectedFormatted, panelOpenAfterClick, rowsAfterCreate,
      inputAppearedOnDblclick, nameAfterRename, rowNameAfterRename, nameAfterUndo, nameAfterRedo,
      historyBeforeEscape, nameAfterEscape, inputGoneAfterEscape, historyAfterEscape,
      selectedAfterRowClick, activeRowClassAfterClick, idsAfterDelete, rowCountAfterDelete,
      countAfterClearAll, emptyStateText, countAfterClearAllUndo,
      projectJson, autosave, panelHiddenAfterClose,
    };
  })()`);

  check(result.panelOpenAfterClick === true, 'Measurements… opens the panel');
  check(result.rowsAfterCreate.length === 3, 'panel shows one row per session measurement, got ' + JSON.stringify(result.rowsAfterCreate));
  check(result.rowsAfterCreate.every(r => /^M\d+$/.test(r.name)), 'unnamed measurements default to M{id}, got ' + JSON.stringify(result.rowsAfterCreate));
  // Click-placed points round-trip through screen<->world<->native
  // transforms, so the ACTUAL native length is close to but not bit-exact
  // 3/4/5 — this proves the click geometry landed where intended without
  // demanding float-exact equality from a UI gesture.
  check(result.expectedValues.every((v, i) => near(v, [3, 4, 5][i], 0.05)),
    'the three Out of Path clicks land within 0.05" of their intended 3/4/5 lengths, got ' + JSON.stringify(result.expectedValues));
  // The row's rendered text vs. the SAME session value read independently
  // through the debug hook — a real cross-check (would fail if the panel
  // mapped a row to the wrong measurement or reformatted it differently),
  // not a comparison of the panel against itself.
  check(result.rowsAfterCreate.every((r, i) => r.value === result.expectedFormatted[i]),
    'each row shows exactly the session\'s own formatted value for that measurement, got '
    + JSON.stringify({ rows: result.rowsAfterCreate, expected: result.expectedFormatted }));
  check(result.inputAppearedOnDblclick === true, 'double-clicking a name swaps in an editable input');
  check(result.nameAfterRename === 'CF length', 'blur commits the typed name into the session record, got ' + JSON.stringify(result.nameAfterRename));
  check(result.rowNameAfterRename === 'CF length', 'the row itself reflects the committed name without a stale rebuild, got ' + result.rowNameAfterRename);
  check(result.nameAfterUndo === null, 'Undo reverts the rename in the session (mini undo stack), got ' + JSON.stringify(result.nameAfterUndo));
  check(result.nameAfterRedo === 'CF length', 'Redo re-applies the rename, got ' + JSON.stringify(result.nameAfterRedo));
  check(result.nameAfterEscape === 'CF length', 'Escape does not commit the abandoned edit, got ' + JSON.stringify(result.nameAfterEscape));
  check(result.inputGoneAfterEscape === true, 'Escape swaps the input back out locally (no stuck editor)');
  check(result.historyAfterEscape === result.historyBeforeEscape, 'Escape on an unchanged name pushes no history entry, got before='
    + result.historyBeforeEscape + ' after=' + result.historyAfterEscape);
  check(result.selectedAfterRowClick === result.idsInCreationOrder[1], 'clicking a row selects that exact measurement, got ' + result.selectedAfterRowClick);
  check(result.activeRowClassAfterClick === true, 'the selected row gets the .active class');
  check(JSON.stringify(result.idsAfterDelete) === JSON.stringify([result.idsInCreationOrder[0], result.idsInCreationOrder[1]]),
    'the panel’s ✕ deletes exactly the row it was clicked on, got ' + JSON.stringify(result.idsAfterDelete));
  check(result.rowCountAfterDelete === 2, 'the panel drops to 2 rows after that delete, got ' + result.rowCountAfterDelete);
  check(result.countAfterClearAll === 0, 'Clear all empties the session, got ' + result.countAfterClearAll);
  check(result.emptyStateText.indexOf('No measurements yet') !== -1, 'the panel shows an explicit empty state, got "' + result.emptyStateText + '"');
  check(result.countAfterClearAllUndo === 2, 'Clear all is ONE undo step — one Undo restores both remaining measurements at once, got ' + result.countAfterClearAllUndo);
  check(!result.projectJson.includes('CF length') && !result.autosave.includes('CF length'),
    'the measurement name given in this test never reaches Project JSON or autosave (session-only, ADR 0062)');
  check(!result.projectJson.includes('dxfMeasureSession') && !result.autosave.includes('dxfMeasureSession'),
    'no Pattern Measure session data (of which name is one field) reaches Project JSON or autosave');
  check(result.panelHiddenAfterClose === true, 'the close button hides the panel');
  console.log('PASS  section 11 (US-113 measurements list panel)');
}

// ---- Section 12: US-111 seam match check ------------------------------------
// 12.1 is pure (dxfMeasureSeamPairStatus takes a bare {judged} number, no
// session at all — exact TD-confirmed boundaries: Match <=1/16", Review
// <=3/16", else Mismatch). 12.2 proves the delta FORMULA
// (|lenA-lenB-ease|) against two along-path measurements of independently-
// known exact length (a single straight segment measured end-to-end via
// Endpoint snap, so the route length is bit-exact, not click-noisy).
// 12.3 drives the real panel UI (Match button -> click target row -> ease
// input -> Unlink) and the mini undo stack end-to-end.
async function section12SeamMatch(s) {
  // 12.1 — pure threshold boundaries.
  const statuses = await s.eval(`(() => {
    const m = window.__braAutoModeDebug.dxf.measure;
    return [
      m.seamPairStatus({ judged: 0 }),
      m.seamPairStatus({ judged: 1/16 }),
      m.seamPairStatus({ judged: 1/16 + 1e-4 }),
      m.seamPairStatus({ judged: 3/16 }),
      m.seamPairStatus({ judged: 3/16 + 1e-4 }),
      m.seamPairStatus(null),
    ];
  })()`);
  check(JSON.stringify(statuses) === JSON.stringify(['match', 'match', 'review', 'review', 'mismatch', 'unknown']),
    'seam status boundaries are exactly Match<=1/16", Review<=3/16", else Mismatch, got ' + JSON.stringify(statuses));

  // 12.2/12.3 — real fixture: two far-apart single-segment pieces (lengths
  // exactly 10 and 12, same far-apart-pieces convention as section 9's
  // TWO_PIECE_DXF) so Along Path end-to-end gives bit-exact route lengths.
  const SEAM_FIXTURE_DXF = doc([dxfLine(0, 0, 10, 0), dxfLine(1000, 0, 1000, 12)]);
  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(SEAM_FIXTURE_DXF)}], 'seamfixture.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));

    const canvas = document.getElementById('boardCanvas');
    const settle = (ms=80) => new Promise(r => setTimeout(r, ms));
    const toScreen = world => { const rect = canvas.getBoundingClientRect(), view = dbg.getView(); return { x: rect.left + world.x * view.zoom + view.panX, y: rect.top + world.y * view.zoom + view.panY }; };
    const fireWorld = (type, world) => { const p = toScreen(world); canvas.dispatchEvent(new MouseEvent(type, {clientX:p.x,clientY:p.y,bubbles:true,button:0})); };
    const clickWorld = async world => { fireWorld('mousedown', world); fireWorld('mouseup', world); await settle(); };

    // Full-segment Along Path via Endpoint snap (bit-exact t=0/t=1, not a
    // click-noisy near-0/near-1) — Midpoint/Intersection off so a snap on
    // the SEGMENT's own endpoint is the only candidate near either click.
    const setSnap = (endpoint, midpoint) => {
      const cur = dbg.dxf.measure.snapEnabled();
      if (cur.endpoint !== endpoint) document.getElementById('dxfMeasureSnapEndpointBtn').click();
      if (cur.midpoint !== midpoint) document.getElementById('dxfMeasureSnapMidpointBtn').click();
    };
    setSnap(true, false);
    const measureWholeSegment = async (pieceIndex) => {
      const seg = dbg.dxf.measure.pieceSegments(pieceIndex)[0];
      document.getElementById('dxfMeasureAlongBtn').click();
      await clickWorld(dbg.dxf.measure.nativeToBoardLive(seg.a, pieceIndex));
      await clickWorld(dbg.dxf.measure.nativeToBoardLive(seg.b, pieceIndex));
      // Along Path always opens the unified route/direction chooser (even
      // for one route) — confirm 'forward' like sections 6/10 do.
      let pending = dbg.dxf.measure.getSession().interaction;
      const idx = pending.candidates.findIndex(c => c.direction === 'forward');
      let guard = 0;
      while (pending.chosenIndex !== idx && guard++ < pending.candidates.length + 2) {
        dbg.dxf.measure.cycleChoice(1); await settle(1);
        pending = dbg.dxf.measure.getSession().interaction;
      }
      dbg.dxf.measure.confirmChoice();
      await settle();
      const session = dbg.dxf.measure.getSession();
      return session.measurements[session.measurements.length - 1].id;
    };

    const historyAfterSeed = dbg.dxf.measure.getSession().historyPast;
    const aId = await measureWholeSegment(0); // length 10
    const historyAfterA = dbg.dxf.measure.getSession().historyPast;
    const bId = await measureWholeSegment(1); // length 12
    const historyAfterB = dbg.dxf.measure.getSession().historyPast;
    const aValue = dbg.dxf.measure.valueInches(aId);
    const bValue = dbg.dxf.measure.valueInches(bId);

    // --- real panel UI: Match -> click target row -> ease -> Unlink ---
    document.getElementById('dxfMeasurementsListBtn').click();
    await settle();
    const rowsAt = () => Array.from(document.querySelectorAll('#dxfMeasurementsBody .dxf-measurement-row'));
    const matchBtnOnRow0 = Array.from(rowsAt()[0].querySelectorAll('.pattern-piece-mini-btn')).find(b => b.textContent === 'Match');
    const matchBtnFound = !!matchBtnOnRow0;
    matchBtnOnRow0.click();
    await settle();
    const targetRow = rowsAt().find(r => r.className.includes('match-target'));
    const targetRowFound = !!targetRow;
    targetRow.click();
    await settle();
    const sessionAfterMatch = dbg.dxf.measure.getSession();
    const pairAfterMatch = sessionAfterMatch.seamPairs[0] || null;
    const historyAfterMatch = sessionAfterMatch.historyPast;
    const deltaAfterMatch = dbg.dxf.measure.seamPairDelta(pairAfterMatch ? pairAfterMatch.id : -1);

    const summaryRow = document.querySelector('#dxfMeasurementsBody .dxf-seam-summary-row');
    const summaryClassAfterMatch = summaryRow ? summaryRow.className : '';
    const summaryTextAfterMatch = summaryRow ? summaryRow.querySelector('.dxf-seam-summary-label').textContent : '';

    const easeInput = summaryRow.querySelector('.dxf-seam-ease-input');
    easeInput.value = '-2';
    easeInput.dispatchEvent(new Event('change'));
    await settle();
    const historyAfterEase = dbg.dxf.measure.getSession().historyPast;
    const pairAfterEase = dbg.dxf.measure.getSession().seamPairs[0];
    const deltaAfterEase = dbg.dxf.measure.seamPairDelta(pairAfterEase.id);
    const summaryClassAfterEase = document.querySelector('#dxfMeasurementsBody .dxf-seam-summary-row').className;

    // --- partner identity (logic) + canvas emphasis (rendering) -------------
    const partnerOfA = dbg.dxf.measure.seamPairPartnerId(aId);
    const partnerOfB = dbg.dxf.measure.seamPairPartnerId(bId);
    dbg.dxf.measure.selectMeasurement(aId);
    await settle(1);
    const rect = canvas.getBoundingClientRect(), view = dbg.getView(), dpr = canvas.width / rect.width;
    const sampleRed = world => {
      const screen = { x: (world.x * view.zoom + view.panX) * dpr, y: (world.y * view.zoom + view.panY) * dpr };
      const data = canvas.getContext('2d').getImageData(Math.max(0, Math.round(screen.x) - 3), Math.max(0, Math.round(screen.y) - 3), 7, 7).data;
      let maxRed = 0;
      for (let i = 0; i < data.length; i += 4) maxRed = Math.max(maxRed, data[i]);
      return maxRed;
    };
    const bMidWorld = dbg.dxf.measure.nativeToBoardLive({ x: 1000, y: 6 }, 1); // midpoint of B's own segment
    const partnerRedWhilePaired = sampleRed(bMidWorld);

    // --- Unlink: B stops being anyone's partner; same sample point, same A
    // selection, should now read as plain inactive (differential, not an
    // absolute threshold — mirrors section 5's own active-vs-inactive proof).
    const unlinkBtn = Array.from(document.querySelector('#dxfMeasurementsBody .dxf-seam-summary-row').querySelectorAll('.pattern-piece-mini-btn'))
      .find(b => b.textContent === 'Unlink');
    unlinkBtn.click();
    await settle();
    const sessionAfterUnlink = dbg.dxf.measure.getSession();
    const historyAfterUnlink = sessionAfterUnlink.historyPast;
    const pairsAfterUnlink = sessionAfterUnlink.seamPairs.length;
    const measurementsAfterUnlink = sessionAfterUnlink.measurements.map(m => m.id);
    dbg.dxf.measure.selectMeasurement(aId);
    await settle(1);
    const partnerRedAfterUnlink = sampleRed(bMidWorld);

    // --- Undo x3: unlink, match, (B's own creation is history #(seed+2)) ---
    dbg.dxf.measure.undo(); dbg.dxf.measure.undo(); dbg.dxf.measure.undo();
    const sessionAfter3Undos = dbg.dxf.measure.getSession();

    // --- Delete member cascades: re-pair, then delete A via its OWN ✕
    // (not Unlink) — the pair must not outlive a deleted member.
    document.getElementById('dxfMeasurementsListBtn').click();
    await settle();
    const matchBtnAgain = Array.from(rowsAt()[0].querySelectorAll('.pattern-piece-mini-btn')).find(b => b.textContent === 'Match');
    matchBtnAgain.click();
    await settle();
    rowsAt().find(r => r.className.includes('match-target')).click();
    await settle();
    const pairBeforeMemberDelete = dbg.dxf.measure.getSession().seamPairs.length;
    const deleteBtnOnRow0 = Array.from(rowsAt()[0].querySelectorAll('.pattern-piece-mini-btn')).find(b => b.textContent === '✕');
    deleteBtnOnRow0.click();
    await settle();
    const sessionAfterMemberDelete = dbg.dxf.measure.getSession();

    document.getElementById('dxfMeasurementsCloseBtn').click();
    document.getElementById('toolSelect').click();
    const projectJson = JSON.stringify(dbg.exportProject());
    const autosave = dbg.autosave.peek() || '';

    return {
      historyAfterSeed, historyAfterA, historyAfterB, aValue, bValue,
      matchBtnFound, targetRowFound, pairAfterMatch, historyAfterMatch, deltaAfterMatch,
      summaryClassAfterMatch, summaryTextAfterMatch,
      historyAfterEase, deltaAfterEase, summaryClassAfterEase,
      partnerOfA, partnerOfB, aId, bId, partnerRedWhilePaired, partnerRedAfterUnlink,
      historyAfterUnlink, pairsAfterUnlink, measurementsAfterUnlink,
      seamPairsAfter3Undos: sessionAfter3Undos.seamPairs.length,
      measurementsAfter3Undos: sessionAfter3Undos.measurements.map(m => m.id),
      pairBeforeMemberDelete,
      pairsAfterMemberDelete: sessionAfterMemberDelete.seamPairs.length,
      measurementsAfterMemberDelete: sessionAfterMemberDelete.measurements.map(m => m.id),
      projectJson, autosave,
    };
  })()`);

  check(near(result.aValue, 10, 1e-9) && near(result.bValue, 12, 1e-9),
    'Endpoint-snapped Along Path on a single straight segment gives bit-exact route length, got ' + JSON.stringify({ a: result.aValue, b: result.bValue }));
  check(result.historyAfterA === result.historyAfterSeed + 1 && result.historyAfterB === result.historyAfterA + 1,
    'each measurement creation is its own history step, got ' + JSON.stringify({ seed: result.historyAfterSeed, a: result.historyAfterA, b: result.historyAfterB }));
  check(result.matchBtnFound === true, 'an unpaired Along Path row shows a Match button');
  check(result.targetRowFound === true, 'arming Match turns the other eligible row into a clickable match-target');
  check(!!result.pairAfterMatch, 'clicking the target row creates a real seam pair, got ' + JSON.stringify(result.pairAfterMatch));
  check(result.historyAfterMatch === result.historyAfterB + 1, 'creating the pair is its own single history step, got '
    + JSON.stringify({ afterB: result.historyAfterB, afterMatch: result.historyAfterMatch }));
  check(near(result.deltaAfterMatch.raw, -2, 1e-9) && near(result.deltaAfterMatch.judged, 2, 1e-9),
    'delta formula |lenA-lenB-ease| with ease=0 on 10 vs 12 gives raw=-2, judged=2, got ' + JSON.stringify(result.deltaAfterMatch));
  check(result.summaryClassAfterMatch.includes('dxf-seam-mismatch'), 'a 2" unexplained gap (over 3/16") renders as Mismatch, got ' + result.summaryClassAfterMatch);
  check(result.summaryTextAfterMatch.indexOf('2') !== -1, 'the summary label shows the 2" delta, got "' + result.summaryTextAfterMatch + '"');
  check(result.historyAfterEase === result.historyAfterMatch + 1, 'setting ease is its own history step, got '
    + JSON.stringify({ afterMatch: result.historyAfterMatch, afterEase: result.historyAfterEase }));
  check(near(result.deltaAfterEase.judged, 0, 1e-9),
    'ease=-2 makes judged = |10-12-(-2)| = 0 (the 2" gap is now fully explained), got ' + JSON.stringify(result.deltaAfterEase));
  check(result.summaryClassAfterEase.includes('dxf-seam-match'), 'with ease explaining the gap the pair now reads as Match, got ' + result.summaryClassAfterEase);
  check(result.partnerOfA === result.bId && result.partnerOfB === result.aId,
    'seamPairPartnerId identifies each member as the other\'s partner, got ' + JSON.stringify({ partnerOfA: result.partnerOfA, partnerOfB: result.partnerOfB, aId: result.aId, bId: result.bId }));
  check(result.partnerRedWhilePaired > result.partnerRedAfterUnlink,
    'B renders heavier while it is A\'s seam-match partner than after Unlink, at the exact same sample point and same A selection (differential proof, not an absolute threshold) — paired='
    + result.partnerRedWhilePaired + ' afterUnlink=' + result.partnerRedAfterUnlink);
  check(result.historyAfterUnlink === result.historyAfterEase + 1, 'Unlink is its own history step, got '
    + JSON.stringify({ afterEase: result.historyAfterEase, afterUnlink: result.historyAfterUnlink }));
  check(result.pairsAfterUnlink === 0 && result.measurementsAfterUnlink.length === 2,
    'Unlink removes the pair but keeps both measurements, got ' + JSON.stringify({ pairs: result.pairsAfterUnlink, measurements: result.measurementsAfterUnlink }));
  check(result.seamPairsAfter3Undos === 0 && result.measurementsAfter3Undos.length === 2,
    '3 Undos (unlink, ease, match) land exactly after both measurements exist but before any pair — no dangling seamPairs reference, got '
    + JSON.stringify({ pairs: result.seamPairsAfter3Undos, measurements: result.measurementsAfter3Undos }));
  check(result.pairBeforeMemberDelete === 1, 'a fresh re-match after undo creates exactly one pair, got ' + result.pairBeforeMemberDelete);
  check(result.pairsAfterMemberDelete === 0 && JSON.stringify(result.measurementsAfterMemberDelete) === JSON.stringify([result.bId]),
    'deleting a PAIRED measurement via its own ✕ (not Unlink) drops the pair but keeps the OTHER measurement, got '
    + JSON.stringify({ pairs: result.pairsAfterMemberDelete, measurements: result.measurementsAfterMemberDelete, expectedSurvivor: result.bId }));
  check(!result.projectJson.includes('seamPairs') && !result.autosave.includes('seamPairs'),
    'seam pairs never reach Project JSON or autosave (session-only, ADR 0062)');
  console.log('PASS  section 12 (US-111 seam match check)');
}

// ---- Section 13: draggable floating panels (Pattern Measurements + Pattern
// Pieces) ---------------------------------------------------------------------
// src/ui/draggable-panel.js is a generic utility wired to both panels' own
// heads (#dxfMeasurementsHead, #patternPiecesHead). Real PointerEvents,
// dispatched on the HEAD element itself (not window) so the test does not
// depend on setPointerCapture actually engaging for a synthetic pointerId —
// the same "degrade to bubbling" path the production code's own try/catch
// exists for.
async function section13DraggablePanels(s) {
  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(doc([dxfLine(0, 0, 10, 0), dxfLine(10, 0, 10, 10), dxfLine(10, 10, 0, 10), dxfLine(0, 10, 0, 0)]))}], 'dragfixture.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    const settle = (ms=80) => new Promise(r => setTimeout(r, ms));

    const dragBy = (handle, startX, startY, dx, dy, steps=6) => {
      const pointerId = 77;
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId, clientX: startX, clientY: startY, bubbles: true, button: 0 }));
      for (let i = 1; i <= steps; i += 1) {
        handle.dispatchEvent(new PointerEvent('pointermove', {
          pointerId, clientX: startX + (dx * i) / steps, clientY: startY + (dy * i) / steps, bubbles: true,
        }));
      }
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: startX + dx, clientY: startY + dy, bubbles: true }));
    };

    // --- Pattern Measurements panel ---
    document.getElementById('dxfMeasurementsListBtn').click();
    await settle();
    const panel = document.getElementById('dxfMeasurementsPanel');
    const head = document.getElementById('dxfMeasurementsHead');
    const boardCard = document.getElementById('boardCard');
    const before = panel.getBoundingClientRect();
    const zIndexBefore = getComputedStyle(panel).zIndex;

    // 1. A real drag moves the panel by exactly the pointer delta. This
    // panel opens docked bottom-right with only 12px of margin, so the
    // delta must move it TOWARD the board's center (up-left) — a
    // right/down delta here would immediately hit the same clamp step 3
    // deliberately tests, making this assertion about clamping instead of
    // about the exact-delta case it is meant to isolate.
    const dx = -60, dy = -40;
    dragBy(head, before.left + 20, before.top + 10, dx, dy);
    await settle();
    const after = panel.getBoundingClientRect();
    const zIndexAfterDrag = panel.style.zIndex;
    const usesExplicitLeftTop = panel.style.right === 'auto' && panel.style.bottom === 'auto'
      && panel.style.left !== '' && panel.style.top !== '';

    // 2. The close button starts its OWN click, never a drag — a pointerdown
    // + move + up sequence there must leave the panel exactly where it is.
    const beforeCloseAttempt = panel.getBoundingClientRect();
    const closeBtn = document.getElementById('dxfMeasurementsCloseBtn');
    const closeBtnRect = closeBtn.getBoundingClientRect();
    dragBy(closeBtn, closeBtnRect.left + 4, closeBtnRect.top + 4, 60, 60);
    await settle();
    const afterCloseAttempt = panel.getBoundingClientRect();
    // dispatchEvent-driven PointerEvents do not reliably synthesize a
    // trailing 'click' the way a real press-release does, so the pointer
    // sequence above only proves "no drag happened" — a SEPARATE, real
    // .click() proves the button's own handler is still reachable
    // (excluding a control from drag must not also disable it).
    const stillOpenBeforeRealClick = !panel.hidden;
    closeBtn.click();
    await settle();
    const closedByRealClick = panel.hidden;
    document.getElementById('dxfMeasurementsListBtn').click(); // reopen for the clamp test below
    await settle();

    // 3. Clamp: an enormous drag cannot push the panel outside the board card.
    const beforeClampDrag = panel.getBoundingClientRect();
    dragBy(head, beforeClampDrag.left + 20, beforeClampDrag.top + 10, 100000, 100000);
    await settle();
    const afterClamp = panel.getBoundingClientRect();
    const boardRect = boardCard.getBoundingClientRect();
    const clampedInsideRight = afterClamp.right <= boardRect.right + 1; // +1: subpixel rounding
    const clampedInsideBottom = afterClamp.bottom <= boardRect.bottom + 1;

    document.getElementById('dxfMeasurementsCloseBtn').click();

    // --- Pattern Pieces panel: same utility, wired independently ---
    document.getElementById('patternPiecesBtn').click();
    await settle();
    const ppPanel = document.getElementById('patternPiecesPanel');
    const ppHead = document.getElementById('patternPiecesHead');
    const ppBefore = ppPanel.getBoundingClientRect();
    dragBy(ppHead, ppBefore.left + 20, ppBefore.top + 10, -30, 15);
    await settle();
    const ppAfter = ppPanel.getBoundingClientRect();

    // --- Overlap bring-to-front: the actual bug report this section exists
    // to cover. Pattern Pieces was just dragged (most recent interaction),
    // so it must currently be ahead of Pattern Measurements even though
    // Pattern Measurements comes LATER in the DOM (the exact ordering a
    // shared FIXED z-index value gets backwards — see the utility's own
    // comment). Then touching Pattern Measurements' BODY (a row, not its
    // header — proving this is not drag-specific) must raise IT above
    // Pattern Pieces in turn.
    document.getElementById('dxfMeasurementsListBtn').click(); // reopen (closed at the clamp step above)
    await settle();
    const ppZBeforeTouch = parseInt(ppPanel.style.zIndex || '0', 10);
    const dxfZBeforeTouch = parseInt(document.getElementById('dxfMeasurementsPanel').style.zIndex || '0', 10);
    const ppAheadAfterItsOwnDrag = ppZBeforeTouch > dxfZBeforeTouch;

    const emptyStateRow = document.querySelector('#dxfMeasurementsBody .dxf-measurement-row');
    emptyStateRow.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 88, bubbles: true, button: 0 }));
    emptyStateRow.dispatchEvent(new PointerEvent('pointerup', { pointerId: 88, bubbles: true }));
    await settle();
    const dxfZAfterTouch = parseInt(document.getElementById('dxfMeasurementsPanel').style.zIndex, 10);
    const ppZAfterTouch = parseInt(ppPanel.style.zIndex, 10);
    const dxfAheadAfterBodyTouch = dxfZAfterTouch > ppZAfterTouch;

    document.getElementById('patternPiecesCloseBtn').click();

    // --- Park near the bottom-right edge of the CURRENT (large) viewport,
    // for the resize-reclamp check run from the OUTER script below (a real
    // CDP viewport resize needs s.setViewport, which only the Node side can
    // call — this eval just sets up a valid, edge-adjacent starting point).
    // boardCard is already declared above (used by the clamp-drag check).
    const boardRectNow = boardCard.getBoundingClientRect();
    panel.style.left = (boardRectNow.width - panel.offsetWidth - 5) + 'px';
    panel.style.top = (boardRectNow.height - panel.offsetHeight - 5) + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    await settle();
    const parkedRect = panel.getBoundingClientRect();
    const validWhileParked = parkedRect.right <= boardRectNow.right + 1 && parkedRect.bottom <= boardRectNow.bottom + 1;

    return {
      dx: after.left - before.left, dy: after.top - before.top,
      usesExplicitLeftTop, zIndexBefore, zIndexAfterDrag,
      closeAttemptMovedX: afterCloseAttempt.left - beforeCloseAttempt.left,
      closeAttemptMovedY: afterCloseAttempt.top - beforeCloseAttempt.top,
      stillOpenBeforeRealClick, closedByRealClick, clampedInsideRight, clampedInsideBottom,
      afterClampLeft: afterClamp.left, afterClampTop: afterClamp.top,
      ppDx: ppAfter.left - ppBefore.left, ppDy: ppAfter.top - ppBefore.top,
      ppAheadAfterItsOwnDrag, dxfAheadAfterBodyTouch, validWhileParked,
    };
  })()`);

  // Resize-reclamp: needs a REAL CDP viewport change (s.setViewport), which
  // only the Node side can trigger — this is why it runs as its own
  // follow-up round-trip instead of living inside the big eval above. The
  // panel above is still open, parked validly near the bottom-right edge.
  await s.setViewport(700, 500);
  const afterShrink = await s.eval(`(async () => {
    await new Promise(r => setTimeout(r, 300)); // let the ResizeObserver callback + layout settle
    const panel = document.getElementById('dxfMeasurementsPanel');
    const boardCard = document.getElementById('boardCard');
    const panelRect = panel.getBoundingClientRect();
    const boardRect = boardCard.getBoundingClientRect();
    document.getElementById('dxfMeasurementsCloseBtn').click();
    return {
      insideRight: panelRect.right <= boardRect.right + 1,
      insideBottom: panelRect.bottom <= boardRect.bottom + 1,
    };
  })()`);
  await s.setViewport(1366, 900);
  result.afterShrink = afterShrink;

  check(near(result.dx, -60, 1) && near(result.dy, -40, 1),
    'dragging the Pattern Measurements header by (-60,-40) moves the panel by exactly that delta, got ' + JSON.stringify({ dx: result.dx, dy: result.dy }));
  check(result.usesExplicitLeftTop, 'after one drag the panel is repositioned via explicit left/top (right/bottom cleared), got '
    + JSON.stringify({ usesExplicitLeftTop: result.usesExplicitLeftTop }));
  check(result.zIndexBefore !== '21' && result.zIndexAfterDrag === '21',
    'starting a drag brings the panel to front (z-index bump), got before=' + result.zIndexBefore + ' after=' + result.zIndexAfterDrag);
  check(result.closeAttemptMovedX === 0 && result.closeAttemptMovedY === 0,
    'a pointer gesture starting ON the close button never drags the panel, got moved=' + JSON.stringify({ x: result.closeAttemptMovedX, y: result.closeAttemptMovedY }));
  check(result.stillOpenBeforeRealClick === true, 'the pointer-on-close-button gesture above did not close the panel either (it was not a drag, and it did not click)');
  check(result.closedByRealClick === true, 'a real .click() on the close button still closes the panel — excluding it from drag never disables it');
  check(result.clampedInsideRight && result.clampedInsideBottom,
    'an enormous drag is clamped inside the board card, not lost off-screen, got ' + JSON.stringify({ left: result.afterClampLeft, top: result.afterClampTop }));
  check(near(result.ppDx, -30, 1) && near(result.ppDy, 15, 1),
    'the SAME utility, wired independently to Pattern Pieces, drags it by exactly its own delta too, got ' + JSON.stringify({ dx: result.ppDx, dy: result.ppDy }));
  check(result.ppAheadAfterItsOwnDrag === true,
    'Pattern Pieces (dragged most recently) is ahead of Pattern Measurements even though Pattern Measurements is LATER in the DOM — a shared fixed z-index would get this backwards');
  check(result.dxfAheadAfterBodyTouch === true,
    'touching Pattern Measurements\' BODY (not its header) brings IT back above Pattern Pieces in turn — bring-to-front fires for any press inside a panel, not only a drag-starting one');
  check(result.validWhileParked === true, 'sanity: the panel is genuinely inside the board card before the window shrinks below');
  check(result.afterShrink.insideRight && result.afterShrink.insideBottom,
    'shrinking the window (1366x900 -> 700x500) re-clamps an already-parked panel back inside the smaller board card instead of leaving it — and its header — stranded under `overflow:hidden`, got '
    + JSON.stringify(result.afterShrink));
  console.log('PASS  section 13 (draggable Pattern Measurements + Pattern Pieces panels)');
}

// ---- Section 14: US-114 snap near-tie disambiguation + Pattern-Measure-only
// size filter ------------------------------------------------------------
// Found via live bug-hunting on a real 85-piece grading-nest export
// (demo/DXF file/3708.dxf, not committed to this repo): with default snap
// on, two DIFFERENT sizes' matching vertices only 0.06 native units apart
// silently resolved to whichever was a hair closer — no ambiguity toast, no
// Tab option — even though the SAME click held with Alt (bypassing snap)
// correctly surfaced all 8 overlapping sizes as Tab-cycleable candidates.
// SIZE_FILTER_DXF reproduces the same shape deterministically: two blocks
// inserted at the exact same point, so their (0,0) corners are exactly
// coincident (distance 0) rather than merely close.
async function section14SnapTiesAndSizeFilter(s) {
  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const importDxf = async (text, name) => {
      const input = document.getElementById('projectFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    };

    // US-112's own restore-defaults convention — do not trust an earlier
    // section's leftover toggle state.
    const setSnap = (endpoint, midpoint) => {
      const current = dbg.dxf.measure.snapEnabled();
      if (current.endpoint !== endpoint) document.getElementById('dxfMeasureSnapEndpointBtn').click();
      if (current.midpoint !== midpoint) document.getElementById('dxfMeasureSnapMidpointBtn').click();
    };
    setSnap(true, true);

    // --- 1. A plain single-piece import: the Size control must stay hidden
    // (nothing to filter) — dxfMeasureAvailableSizeLabels' own "fewer than 2
    // distinct labels" rule.
    await importDxf(${JSON.stringify(SQUARE_DXF)}, 'plain.dxf');
    const sizeWrapHiddenForPlainFile = document.getElementById('dxfMeasureSizeWrap').hidden;
    const availableLabelsForPlainFile = dbg.dxf.measure.availableSizeLabels();

    // --- 2. The grading-nest fixture: two sizes inserted at the same point.
    await importDxf(${JSON.stringify(SIZE_FILTER_DXF)}, 'sizefilter.dxf');
    const availableLabels = dbg.dxf.measure.availableSizeLabels();
    const sizeWrapVisible = !document.getElementById('dxfMeasureSizeWrap').hidden;
    const sizeSelectOptions = Array.from(document.getElementById('dxfMeasureSizeSelect').options).map(o => o.value);
    const pieceLabels = [0, 1].map(i => dbg.dxf.measure.pieceSizeLabel(i));

    const canvas = document.getElementById('boardCanvas');
    // US-112's own gotcha, rediscovered here: rect/view must be re-read on
    // EVERY call, never captured once outside — arming Pattern Measure grows
    // the status-bar text (wraps a line), which shifts the canvas's own
    // rect.top out from under a stale capture. Same shape as section 10.2's
    // toScreen, deliberately.
    const toScreen = world => { const rect = canvas.getBoundingClientRect(), view = dbg.getView(); return { x: rect.left + world.x * view.zoom + view.panX, y: rect.top + world.y * view.zoom + view.panY }; };
    const fireWorld = (type, world, extra={}) => { const sp = toScreen(world); canvas.dispatchEvent(new MouseEvent(type, Object.assign({clientX:sp.x,clientY:sp.y,bubbles:true,button:0}, extra))); };
    const clickWorld = (world, extra={}) => { fireWorld('mousedown', world, extra); fireWorld('mouseup', world, extra); };
    const corner = dbg.dxf.measure.nativeToBoardLive({ x: 0, y: 0 }, 0);
    // A few px off the shared corner, same "diagonally outside" convention
    // section 10.2 uses — never test with the raw exact point, since a real
    // TD's click never lands pixel-perfect either.
    const off = 6 / dbg.getView().zoom / Math.SQRT2;
    const nearCorner = { x: corner.x - off, y: corner.y - off };

    // --- 3. Unfiltered: both sizes' snap candidates exist at the exact same
    // point, and the click resolves against BOTH (never a silent pick).
    const candidatesUnfiltered = dbg.dxf.measure.snapCandidates(corner);
    const tieCandidatesUnfiltered = dbg.dxf.measure.snapTieCandidates(nearCorner);
    document.getElementById('dxfMeasureAlongBtn').click();
    clickWorld(nearCorner);
    const interactionUnfiltered = dbg.dxf.measure.getSession().interaction;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    // --- 4. Filter to PIECE_S via the REAL <select> — the change event is
    // the only sanctioned way to drive this (no debug setter exists, same
    // "no mutating shortcuts for a real UI path" rule as every other
    // TD-facing control in this file).
    document.getElementById('dxfMeasureAlongBtn').click();
    const sizeSelect = document.getElementById('dxfMeasureSizeSelect');
    sizeSelect.value = 'S';
    sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const activeAfterFilter = dbg.dxf.measure.getSession().activeSizeLabel;
    const candidatesFiltered = dbg.dxf.measure.snapCandidates(corner);
    clickWorld(nearCorner);
    const interactionFiltered = dbg.dxf.measure.getSession().interaction;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    // --- 5. Switching the filter mid-placement drops the stale interaction
    // (its refs may point at a now-hidden piece).
    document.getElementById('dxfMeasureAlongBtn').click();
    clickWorld(nearCorner);
    const midPlacementBeforeSwitch = dbg.dxf.measure.getSession().interaction;
    sizeSelect.value = '';
    sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const midPlacementAfterSwitch = dbg.dxf.measure.getSession().interaction;
    const activeAfterReset = dbg.dxf.measure.getSession().activeSizeLabel;

    document.getElementById('toolSelect').click();
    return {
      sizeWrapHiddenForPlainFile, availableLabelsForPlainFile,
      availableLabels, sizeWrapVisible, sizeSelectOptions, pieceLabels,
      candidatesUnfiltered, tieCandidatesUnfiltered, interactionUnfiltered,
      activeAfterFilter, candidatesFiltered, interactionFiltered,
      midPlacementBeforeSwitch, midPlacementAfterSwitch, activeAfterReset,
    };
  })()`);

  check(result.sizeWrapHiddenForPlainFile === true, 'Size control stays hidden for a plain single-piece import, got hidden=' + result.sizeWrapHiddenForPlainFile);
  check(Array.isArray(result.availableLabelsForPlainFile) && result.availableLabelsForPlainFile.length === 0,
    'no size labels detected for a plain (no-BLOCK) import, got ' + JSON.stringify(result.availableLabelsForPlainFile));

  // ADR 0084: the dropdown lists SIZE tokens (the part of the block name
  // after its last underscore), not whole block names — PIECE_S/PIECE_M -> S/M.
  check(JSON.stringify(result.availableLabels) === JSON.stringify(['S', 'M']),
    'both INSERTed blocks\' size tokens are detected, in piece order, got ' + JSON.stringify(result.availableLabels));
  check(result.sizeWrapVisible === true, 'Size control becomes visible once 2+ sizes are detected');
  check(JSON.stringify(result.sizeSelectOptions) === JSON.stringify(['', 'S', 'M']),
    'the real <select> is populated with "All sizes" + both detected size tokens, got ' + JSON.stringify(result.sizeSelectOptions));
  check(JSON.stringify(result.pieceLabels) === JSON.stringify(['PIECE_S', 'PIECE_M']),
    'each piece\'s own label matches the block it came from, got ' + JSON.stringify(result.pieceLabels));

  check(result.candidatesUnfiltered.length >= 2 && new Set(result.candidatesUnfiltered.map(c => c.pieceIndex)).size === 2,
    'two different pieces both have a snap candidate at the exact same point, got ' + JSON.stringify(result.candidatesUnfiltered));
  check(result.candidatesUnfiltered.every(c => c.distance < 1e-6),
    'both candidates sit at distance 0 from that exact point (this fixture inserts both blocks at the same point on purpose), got '
    + JSON.stringify(result.candidatesUnfiltered.map(c => c.distance)));
  check(result.tieCandidatesUnfiltered.length === 2 && new Set(result.tieCandidatesUnfiltered.map(c => c.pieceIndex)).size === 2,
    'the near-tie set (one candidate per tied piece) includes BOTH pieces, got ' + JSON.stringify(result.tieCandidatesUnfiltered));
  check(result.interactionUnfiltered && result.interactionUnfiltered.type === 'choosing-entity'
    && result.interactionUnfiltered.hits.length === 4 && new Set(result.interactionUnfiltered.hits.map(h => h.pieceIndex)).size === 2,
    'an unfiltered click at the tied point enters choosing-entity with all 4 hits (2 pieces x 2 adjacent segments each) — never a silent pick, got '
    + JSON.stringify(result.interactionUnfiltered));

  check(result.activeAfterFilter === 'S', 'the real <select> change event sets activeSizeLabel (to the size token), got ' + JSON.stringify(result.activeAfterFilter));
  check(result.candidatesFiltered.length >= 1 && result.candidatesFiltered.every(c => c.pieceIndex === 0),
    'once filtered to size S, every remaining candidate at that point belongs to piece 0 only, got ' + JSON.stringify(result.candidatesFiltered));
  check(result.interactionFiltered && result.interactionFiltered.type === 'choosing-entity'
    && result.interactionFiltered.hits.every(h => h.pieceIndex === 0),
    'once filtered, the SAME click only ever resolves against the selected size — PIECE_M is invisible to it, got '
    + JSON.stringify(result.interactionFiltered));

  check(result.midPlacementBeforeSwitch != null, 'sanity: a placement really was in flight before switching the filter');
  check(result.midPlacementAfterSwitch === null, 'switching the active size drops a stale in-flight interaction rather than leaving refs into a now-hidden piece, got '
    + JSON.stringify(result.midPlacementAfterSwitch));
  check(result.activeAfterReset === null, 'resetting the select to "All sizes" clears the filter, got ' + JSON.stringify(result.activeAfterReset));

  console.log('PASS  section 14 (US-114 snap near-tie disambiguation + Pattern-Measure-only size filter)');
}

// Found 2026-09-01 testing real production files (2984-SONASHAPE.dxf,
// 3380.dxf) — two gaps in the US-114 machinery this section's own fixtures
// never exercised: (1) the Size filter activating for files whose 2+
// distinct block labels are ordinary side-by-side pieces, not a genuine
// grading-nest overlap (ADR 0078-adjacent fix in dxfMeasureAvailableSizeLabels,
// dxf-measure-session.js); (2) a piece authored as exact duplicate segments
// forcing a pointless Tab/Enter choice between two options that measure
// identically (fix: dxfMeasureCollapseDuplicateSegmentHits, dxf-measure-snap.js).
async function section15SizeFilterOverlapGateAndDuplicateSegments(s) {
  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const importDxf = async (text, name) => {
      const input = document.getElementById('projectFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    };
    const setSnap = (endpoint, midpoint) => {
      const current = dbg.dxf.measure.snapEnabled();
      if (current.endpoint !== endpoint) document.getElementById('dxfMeasureSnapEndpointBtn').click();
      if (current.midpoint !== midpoint) document.getElementById('dxfMeasureSnapMidpointBtn').click();
    };
    setSnap(true, true);

    // --- 1. Two distinct block labels that never overlap: the real gap
    // found on 2984-SONASHAPE.dxf (5 different garment pieces, one BLOCK
    // each) — the Size control must stay hidden, not offer a filter that
    // would silently hide 4 of the 5 pieces with nothing genuinely ambiguous
    // to resolve.
    await importDxf(${JSON.stringify(NON_OVERLAPPING_PIECES_DXF)}, 'nonoverlap.dxf');
    const nonOverlapLabels = dbg.dxf.measure.availableSizeLabels();
    const nonOverlapWrapHidden = document.getElementById('dxfMeasureSizeWrap').hidden;

    // --- 2. Regression: the genuine grading-nest fixture from section 14
    // (same-position overlap) must still activate the filter.
    await importDxf(${JSON.stringify(SIZE_FILTER_DXF)}, 'sizefilter2.dxf');
    const overlapLabels = dbg.dxf.measure.availableSizeLabels();
    const overlapWrapHidden = document.getElementById('dxfMeasureSizeWrap').hidden;

    // --- 3. A piece authored as two exact-duplicate closed outlines (the
    // real shape found on 3380.dxf): a click at the shared midpoint of a
    // duplicated edge must resolve unambiguously, not open choosing-entity
    // for two options that measure identically.
    await importDxf(${JSON.stringify(DUPLICATE_SEGMENT_DXF)}, 'dupseg.dxf');
    const segCount = dbg.dxf.measure.pieceSegments(0).length;
    const nativeMid = { x: 5, y: 0 }; // midpoint of both dxfLine(0,0,10,0) copies (segments 0 and 4)
    const boardMid = dbg.dxf.measure.nativeToBoardLive(nativeMid, 0);
    const rawCandidatesAtMidpoint = dbg.dxf.measure.snapCandidates(boardMid);

    const canvas = document.getElementById('boardCanvas');
    const toScreen = world => { const rect = canvas.getBoundingClientRect(), view = dbg.getView(); return { x: rect.left + world.x * view.zoom + view.panX, y: rect.top + world.y * view.zoom + view.panY }; };
    const fireWorld = (type, world, extra={}) => { const sp = toScreen(world); canvas.dispatchEvent(new MouseEvent(type, Object.assign({clientX:sp.x,clientY:sp.y,bubbles:true,button:0}, extra))); };
    const clickWorld = (world, extra={}) => { fireWorld('mousedown', world, extra); fireWorld('mouseup', world, extra); };

    document.getElementById('dxfMeasureAlongBtn').click();
    clickWorld(boardMid);
    const interactionAtDuplicateMidpoint = dbg.dxf.measure.getSession().interaction;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    document.getElementById('toolSelect').click();
    return {
      nonOverlapLabels, nonOverlapWrapHidden, overlapLabels, overlapWrapHidden,
      segCount, rawCandidatesAtMidpoint, interactionAtDuplicateMidpoint,
    };
  })()`);

  check(Array.isArray(result.nonOverlapLabels) && result.nonOverlapLabels.length === 0,
    'the Size filter must not activate for 2+ distinct block labels that never overlap (ordinary side-by-side pieces), got ' + JSON.stringify(result.nonOverlapLabels));
  check(result.nonOverlapWrapHidden === true, 'the Size control stays hidden for non-overlapping distinct pieces');

  check(JSON.stringify(result.overlapLabels) === JSON.stringify(['S', 'M']),
    'regression: the genuine same-position grading-nest fixture must still activate the filter (size tokens S/M), got ' + JSON.stringify(result.overlapLabels));
  check(result.overlapWrapHidden === false, 'regression: the Size control stays visible for a genuine overlapping grading nest');

  check(result.segCount === 8, 'sanity: the duplicate-segment fixture really does carry 8 raw segments (4 unique edges authored twice), got ' + result.segCount);
  check(result.rawCandidatesAtMidpoint.length >= 2,
    'sanity: BEFORE collapsing, the two duplicate segments really do each contribute their own unclustered midpoint candidate at the same point, got '
    + JSON.stringify(result.rawCandidatesAtMidpoint));
  check(result.interactionAtDuplicateMidpoint && result.interactionAtDuplicateMidpoint.type === 'awaiting-b',
    'a click at a duplicated edge\'s shared midpoint must resolve unambiguously (hits collapsed to 1, no Tab/Enter choice between two options that measure identically), got '
    + JSON.stringify(result.interactionAtDuplicateMidpoint));

  console.log('PASS  section 15 (Size filter overlap gate + duplicate-segment hit collapsing)');
}

// ADR 0084 — two findings from a 2026-09-02 live pass on real files
// (findings-dxf.md Findings 11 and 12):
//  (11) the Size filter grouped by WHOLE block name, so on a nest grading two
//       different pieces at one position, selecting one piece's size hid the
//       other piece entirely (no click, snap or Alt-bypass could reach it);
//       it now groups by the size token after the name's last underscore.
//  (12) clicking the same point for A and B on a CLOSED piece failed with a
//       generic toast; the kernel now returns the loop itself as the route,
//       and an open path reports the distinct SAME_POINT reason instead.
async function section16SizeTokensAndLoopRoutes(s) {
  // --- Pure kernel: same-point A/B.
  const pure = await s.eval(`(() => {
    const d = window.__braAutoModeDebug.dxf.measure;
    const square = d.parseNative(${JSON.stringify(SQUARE_DXF)}).pieces[0].segments;
    const chain = d.parseNative(${JSON.stringify(CHAIN_DXF)}).pieces[0].segments;
    const circleParsed = d.parseNative(${JSON.stringify(CIRCLE_DXF)});
    const circle = circleParsed.ok ? circleParsed.pieces[0].segments : null;
    return {
      squareCorner: d.enumerateRoutesRaw(square, {segIndex:0,t:0}, {segIndex:0,t:0}),
      squareMidEdge: d.enumerateRoutesRaw(square, {segIndex:1,t:0.5}, {segIndex:1,t:0.5}),
      squareDistinct: d.enumerateRoutesRaw(square, {segIndex:0,t:0.5}, {segIndex:2,t:0.5}),
      chainSamePoint: d.enumerateRoutesRaw(chain, {segIndex:2,t:0.5}, {segIndex:2,t:0.5}),
      circleSegs: circle,
      circleLoop: circle ? d.enumerateRoutesRaw(circle, {segIndex:0,t:0}, {segIndex:0,t:0}) : null,
      circleQuarter: circle ? d.enumerateRoutesRaw(circle, {segIndex:0,t:0}, {segIndex:0,t:0.25}) : null,
    };
  })()`);
  check(pure.squareCorner.ok && pure.squareCorner.routes.length === 1 && near(pure.squareCorner.routes[0].length, 40, 1e-9),
    'same corner for A and B on a closed square yields exactly ONE loop route of the full 40-unit perimeter (both walking directions collapsed to one), got ' + JSON.stringify(pure.squareCorner));
  check(pure.squareCorner.routes[0].steps.length === 4 && new Set(pure.squareCorner.routes[0].steps.map(st => st.segIndex)).size === 4,
    'that loop route walks all 4 edges once each, got ' + JSON.stringify(pure.squareCorner.routes[0].steps));
  check(pure.squareMidEdge.ok && pure.squareMidEdge.routes.length === 1 && near(pure.squareMidEdge.routes[0].length, 40, 1e-9)
    && pure.squareMidEdge.routes[0].steps.length === 5,
    'same mid-edge point for A and B also yields the one full-perimeter loop (the split edge contributes two half-steps), got ' + JSON.stringify(pure.squareMidEdge));
  check(pure.squareDistinct.ok && pure.squareDistinct.routes.length === 2,
    'regression: two DIFFERENT points on the square still yield the 2 complementary routes, got ' + JSON.stringify(pure.squareDistinct.routes && pure.squareDistinct.routes.length));
  check(!pure.chainSamePoint.ok && pure.chainSamePoint.reason === 'SAME_POINT' && pure.chainSamePoint.routes.length === 0,
    'same point for A and B on an OPEN chain reports SAME_POINT (not NO_CONNECTED_PATH — the points are trivially connected), got ' + JSON.stringify(pure.chainSamePoint));
  check(Array.isArray(pure.circleSegs) && pure.circleSegs.length === 1 && pure.circleSegs[0].kind === 'arc',
    'sanity: a CIRCLE parses to one self-closing native arc segment, got ' + JSON.stringify(pure.circleSegs));
  check(pure.circleLoop && pure.circleLoop.ok && pure.circleLoop.routes.length === 1 && near(pure.circleLoop.routes[0].length, 2 * Math.PI * 5, 1e-9),
    'same point for A and B on a full circle (a self-loop edge) yields one route of the exact circumference 2*pi*5, got ' + JSON.stringify(pure.circleLoop));
  check(pure.circleQuarter && pure.circleQuarter.ok && pure.circleQuarter.routes.length === 2
    && near(Math.min(...pure.circleQuarter.routes.map(r => r.length)), 2 * Math.PI * 5 / 4, 1e-9)
    && near(Math.max(...pure.circleQuarter.routes.map(r => r.length)), 2 * Math.PI * 5 * 3 / 4, 1e-9),
    'regression: two different points on the circle still yield the short arc and the long arc, got ' + JSON.stringify(pure.circleQuarter && pure.circleQuarter.routes.map(r => r.length)));

  // --- Real UI: the two-family nest + the same-point loop through real clicks.
  const result = await s.eval(`(async () => {
    document.getElementById('modeManualBtn').click();
    const dbg = window.__braAutoModeDebug;
    const p = dbg.exportProject();
    p.state.annotations = []; p.state.images = [];
    await dbg.loadProject(p);
    document.getElementById('modeManualBtn').click();
    if (!dbg.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    document.getElementById('toolsMenuBtn').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const importDxf = async (text, name) => {
      const input = document.getElementById('projectFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([text], name, { type: 'application/octet-stream' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 20; i += 1) await new Promise(r => requestAnimationFrame(r));
    };
    const setSnap = (endpoint, midpoint) => {
      const current = dbg.dxf.measure.snapEnabled();
      if (current.endpoint !== endpoint) document.getElementById('dxfMeasureSnapEndpointBtn').click();
      if (current.midpoint !== midpoint) document.getElementById('dxfMeasureSnapMidpointBtn').click();
    };
    setSnap(true, true);
    const canvas = document.getElementById('boardCanvas');
    const toScreen = world => { const rect = canvas.getBoundingClientRect(), view = dbg.getView(); return { x: rect.left + world.x * view.zoom + view.panX, y: rect.top + world.y * view.zoom + view.panY }; };
    const fireWorld = (type, world, extra={}) => { const sp = toScreen(world); canvas.dispatchEvent(new MouseEvent(type, Object.assign({clientX:sp.x,clientY:sp.y,bubbles:true,button:0}, extra))); };
    const clickWorld = (world, extra={}) => { fireWorld('mousedown', world, extra); fireWorld('mouseup', world, extra); };
    const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const toastText = () => document.getElementById('toast').textContent;

    // --- 1. Two piece families graded at one position.
    await importDxf(${JSON.stringify(TWO_FAMILY_NEST_DXF)}, 'twofamily.dxf');
    const sess = dbg.dxf.measure.getSession();
    const names = Array.from({ length: sess.pieceCount }, (_, i) => dbg.dxf.measure.pieceSizeLabel(i));
    const tokens = Array.from({ length: sess.pieceCount }, (_, i) => dbg.dxf.measure.pieceSizeToken(i));
    const options = dbg.dxf.measure.availableSizeLabels();
    const selectOptions = Array.from(document.getElementById('dxfMeasureSizeSelect').options).map(o => o.value);
    const idx = name => names.indexOf(name);
    // The shared (0,0) corner: every one of the 4 pieces has a vertex there.
    const corner = dbg.dxf.measure.nativeToBoardLive({ x: 0, y: 0 }, idx('CUP_S'));
    const piecesAtCornerUnfiltered = [...new Set(dbg.dxf.measure.snapCandidates(corner).map(c => c.pieceIndex))].sort();
    const sizeSelect = document.getElementById('dxfMeasureSizeSelect');
    sizeSelect.value = 'S';
    sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    const activeToken = dbg.dxf.measure.getSession().activeSizeLabel;
    const piecesAtCornerSizeS = [...new Set(dbg.dxf.measure.snapCandidates(corner).map(c => c.pieceIndex))].sort();
    // The lining's own diagonal midpoint (5,5): reachable ONLY through the
    // lining piece — a point the cup outline never has. Alt-bypass takes the
    // raw hit-test path, so this proves both gates agree.
    const liningMid = dbg.dxf.measure.nativeToBoardLive({ x: 5, y: 5 }, idx('LINING_S'));
    const liningHitsSizeS = [...new Set(dbg.dxf.measure.snapCandidates(liningMid).map(c => c.pieceIndex))].sort();
    document.getElementById('dxfMeasureAlongBtn').click();
    clickWorld(liningMid, { altKey: true });
    const liningAltInteraction = dbg.dxf.measure.getSession().interaction;
    escape();
    sizeSelect.value = 'M';
    sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    // The M lining's own diagonal midpoint is (6,6) — (5,5) is a snap point
    // only on the S lining, so re-aim at the M piece's own geometry.
    const liningMidM = dbg.dxf.measure.nativeToBoardLive({ x: 6, y: 6 }, idx('LINING_M'));
    const liningHitsSizeM = [...new Set(dbg.dxf.measure.snapCandidates(liningMidM).map(c => c.pieceIndex))].sort();
    sizeSelect.value = '';
    sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));

    // --- 2. Same point twice on a closed square: a real loop measurement.
    await importDxf(${JSON.stringify(SQUARE_DXF)}, 'loopsquare.dxf');
    const sq = dbg.dxf.measure.getSession();
    const sqIndex = sq.pieceCount - 1;
    const sqCorner = dbg.dxf.measure.nativeToBoardLive({ x: 0, y: 0 }, sqIndex);
    const off = 6 / dbg.getView().zoom / Math.SQRT2;
    const nearSqCorner = { x: sqCorner.x - off, y: sqCorner.y - off };
    document.getElementById('dxfMeasureAlongBtn').click();
    clickWorld(nearSqCorner);
    let afterA = dbg.dxf.measure.getSession().interaction;
    // The corner is shared by 2 segments: resolve the entity choice like a TD would.
    if (afterA && afterA.type === 'choosing-entity') { dbg.dxf.measure.confirmChoice(); afterA = dbg.dxf.measure.getSession().interaction; }
    clickWorld(nearSqCorner);
    let afterB = dbg.dxf.measure.getSession().interaction;
    if (afterB && afterB.type === 'choosing-entity') { dbg.dxf.measure.confirmChoice(); afterB = dbg.dxf.measure.getSession().interaction; }
    const loopChoice = afterB ? { type: afterB.type, candidates: afterB.candidates, routes: afterB.routes && afterB.routes.map(r => r.length) } : null;
    const before = dbg.dxf.measure.getSession().measurementCount;
    dbg.dxf.measure.confirmChoice();
    const sessAfter = dbg.dxf.measure.getSession();
    const loopMeasurement = sessAfter.measurements[sessAfter.measurements.length - 1];
    const loopValue = loopMeasurement ? dbg.dxf.measure.valueInches(loopMeasurement.id) : null;

    // --- 3. Same point twice on an OPEN chain: the specific toast, A kept.
    await importDxf(${JSON.stringify(CHAIN_DXF)}, 'loopchain.dxf');
    const ch = dbg.dxf.measure.getSession();
    const chIndex = ch.pieceCount - 1;
    const chMid = dbg.dxf.measure.nativeToBoardLive({ x: 25, y: 0 }, chIndex);
    document.getElementById('dxfMeasureAlongBtn').click();
    clickWorld(chMid);
    const chainAfterA = dbg.dxf.measure.getSession().interaction;
    clickWorld(chMid);
    // toast.js queues behind an earlier still-visible toast (TOAST_MIN_VISIBLE_MS)
    // — poll for the expected text, never read the toast element once (this file's own
    // section 8/9 convention).
    let chainToast = '';
    for (let i = 0; i < 40 && !chainToast.includes('same point as A'); i += 1) {
      chainToast = toastText();
      if (!chainToast.includes('same point as A')) await new Promise(r => setTimeout(r, 100));
    }
    const chainAfterB = dbg.dxf.measure.getSession().interaction;
    escape();
    document.getElementById('toolSelect').click();
    return {
      names, tokens, options, selectOptions, piecesAtCornerUnfiltered, activeToken, piecesAtCornerSizeS,
      liningHitsSizeS, liningAltInteraction, liningHitsSizeM,
      idxCupS: idx('CUP_S'), idxLiningS: idx('LINING_S'), idxCupM: idx('CUP_M'), idxLiningM: idx('LINING_M'),
      loopChoice, before, measurementCountAfter: sessAfter.measurementCount, loopMeasurement, loopValue,
      chainAfterA, chainToast, chainAfterB,
    };
  })()`);

  check(JSON.stringify([...result.names].sort()) === JSON.stringify(['CUP_M', 'CUP_S', 'LINING_M', 'LINING_S']),
    'sanity: all four blocks imported as pieces with their own names, got ' + JSON.stringify(result.names));
  check(result.tokens.every((t, i) => t === result.names[i].split('_').pop()),
    'each piece\'s size token is the part of its block name after the last underscore, got ' + JSON.stringify(result.tokens));
  check(JSON.stringify(result.options) === JSON.stringify(['S', 'M']) && JSON.stringify(result.selectOptions) === JSON.stringify(['', 'S', 'M']),
    'the Size dropdown offers the two SIZES, not the four block names, got ' + JSON.stringify([result.options, result.selectOptions]));
  check(result.piecesAtCornerUnfiltered.length === 4, 'sanity: unfiltered, all 4 pieces share the (0,0) corner, got ' + JSON.stringify(result.piecesAtCornerUnfiltered));
  check(result.activeToken === 'S', 'selecting "S" stores the size token, got ' + JSON.stringify(result.activeToken));
  check(JSON.stringify(result.piecesAtCornerSizeS) === JSON.stringify([result.idxCupS, result.idxLiningS].sort()),
    'filtered to size S, the corner resolves against BOTH size-S pieces (cup AND lining) and neither M piece — Finding 11: the lining is no longer hidden, got '
    + JSON.stringify(result.piecesAtCornerSizeS) + ' expected ' + JSON.stringify([result.idxCupS, result.idxLiningS].sort()));
  check(JSON.stringify(result.liningHitsSizeS) === JSON.stringify([result.idxLiningS]),
    'filtered to size S, the lining\'s own diagonal midpoint is reachable via snap, got ' + JSON.stringify(result.liningHitsSizeS));
  check(result.liningAltInteraction && result.liningAltInteraction.type === 'awaiting-b' && result.liningAltInteraction.a.pieceIndex === result.idxLiningS,
    'filtered to size S, an Alt-bypass click on the lining diagonal places point A on the lining (raw hit-test agrees with snap), got ' + JSON.stringify(result.liningAltInteraction));
  check(JSON.stringify(result.liningHitsSizeM) === JSON.stringify([result.idxLiningM]),
    'filtered to size M, the M lining\'s diagonal midpoint resolves to the M lining only (the filter still hides other SIZES), got ' + JSON.stringify(result.liningHitsSizeM));

  check(result.loopChoice && result.loopChoice.type === 'choosing-route' && result.loopChoice.candidates.length === 2
    && result.loopChoice.routes.length === 1 && near(result.loopChoice.routes[0], 40, 1e-9),
    'Finding 12: clicking the same corner twice on a closed square enters choosing-route with ONE 40-unit loop offered forward/reverse (not a failure toast), got ' + JSON.stringify(result.loopChoice));
  check(result.measurementCountAfter === result.before + 1 && result.loopMeasurement && result.loopMeasurement.mode === 'along-path'
    && near(result.loopMeasurement.route.length, 40, 1e-9) && near(result.loopValue, 40, 1e-9),
    'confirming commits a real 40-unit full-perimeter measurement, got ' + JSON.stringify({ count: result.measurementCountAfter, before: result.before, m: result.loopMeasurement, value: result.loopValue }));

  check(result.chainAfterA && result.chainAfterA.type === 'awaiting-b', 'sanity: point A placed on the open chain, got ' + JSON.stringify(result.chainAfterA));
  check(typeof result.chainToast === 'string' && result.chainToast.includes('same point as A'),
    'same point twice on an OPEN chain shows the specific same-point toast, got ' + JSON.stringify(result.chainToast));
  check(result.chainAfterB && result.chainAfterB.type === 'awaiting-b',
    'and keeps point A armed so the TD can pick a different B, got ' + JSON.stringify(result.chainAfterB));

  console.log('PASS  section 16 (ADR 0084: size tokens keep every piece of a size reachable + same-point loop routes)');
}

// ---- Section 1: pure kernel unit tests -------------------------------------
async function section1PureKernel(s) {
  const reasons = await s.eval('window.__braAutoModeDebug.dxf.measure.reasonCodes()');
  check(reasons.NO_CONNECTED_PATH === 'NO_CONNECTED_PATH' && reasons.AMBIGUOUS_ROUTE === 'AMBIGUOUS_ROUTE'
    && reasons.ROUTE_SEARCH_TRUNCATED === 'ROUTE_SEARCH_TRUNCATED'
    && reasons.NON_FINITE_GEOMETRY === 'NON_FINITE_GEOMETRY' && reasons.UNSUPPORTED_GEOMETRY === 'UNSUPPORTED_GEOMETRY'
    && reasons.NO_HIT === 'NO_HIT' && reasons.NO_DXF_SESSION === 'NO_DXF_SESSION' && reasons.SAME_POINT === 'SAME_POINT',
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
    const input = document.getElementById('projectFileInput');
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
      const input = document.getElementById('projectFileInput');
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
    const input = document.getElementById('projectFileInput');
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
    const input = document.getElementById('projectFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(fixtureText)}], '3380.dxf', { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 40; i += 1) await new Promise(r => requestAnimationFrame(r));
    // US-112: this fixture deliberately clicks ARBITRARY (segIndexInPiece, t)
    // references — including t=.3/.7 on one segment and t=.5/.5 on two
    // DIFFERENT segments — to exercise route/direction/entity-ambiguity
    // machinery at exact points the topology graph considers interesting.
    // Endpoint/Midpoint snap (on by default) can legitimately pull one of
    // those exact clicks onto a DIFFERENT nearby segment's own snap point
    // when two segments sit within the snap tolerance of each other (dense
    // pattern geometry) — confirmed by first running this fixture with the
    // new default snap ON: "piece 0 forward" failed with "intended entity is
    // absent from explicit candidate set" (findPair's t=.5/.5 case landed on
    // a neighboring segment's own midpoint instead of the one it asked for).
    // That is snap doing exactly what US-112 asks — attract to the nearest
    // enabled snap point — not a kernel/session regression, so the fix is to
    // turn snap off for this precision fixture (exactly the toggle a TD would
    // use for the same reason), not to weaken the snap tolerance. Section 10
    // below is what actually tests snap.
    document.getElementById('dxfMeasureSnapEndpointBtn').click();
    document.getElementById('dxfMeasureSnapMidpointBtn').click();
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
    // US-112: restore the snap toggles this section turned off near its own
    // top (see the comment there) — state.dxfMeasureSnap* is global, not
    // session-scoped, so it outlives this section in this one continuous
    // browser page. This is hygiene, not a correctness dependency: section
    // 10 does not trust it (it force-sets its own required toggle state
    // before asserting anything) — first found the hard way when this
    // restore was missing and section 10 silently ran against the OFF state
    // section 6 leaves behind by default.
    document.getElementById('dxfMeasureSnapEndpointBtn').click();
    document.getElementById('dxfMeasureSnapMidpointBtn').click();
    return {
      pieceCount:finalSession.pieceCount,pieceSegmentCounts:finalSession.pieceSegmentCounts,source:finalSession.source,perPiece,
      measurementCount:finalSession.measurementCount,projectJson:JSON.stringify(dbg.exportProject()),autosave:dbg.autosave.peek()||'',
      measurementAnnIds:dbg.getMeasurementAnnIds(),parserDurationMs:finalSession.source.nativeParseDurationMs,
      snapRestored:dbg.dxf.measure.snapEnabled(),
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
  check(result.snapRestored.endpoint === true && result.snapRestored.midpoint === true,
    'this section restores the Endpoint/Midpoint snap toggles it turned off for its own precision clicks, got ' + JSON.stringify(result.snapRestored));
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
