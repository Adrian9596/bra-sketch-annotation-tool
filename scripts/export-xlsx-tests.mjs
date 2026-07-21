#!/usr/bin/env node
// End-to-end verification of the Export Excel (.xlsx) measurement spec.
// Boots the app in headless Chrome, seeds a fixture project (image + Size L
// specs) via the debug API, builds the workbook with a frozen date through
// window.__braAutoModeDebug.exportSpecXlsxBase64, then unzips the bytes in
// Node (STORE method — mirror of the writer in src/render/export-xlsx.js)
// and asserts: all workbook parts present, header labels exact, alpha and
// depth grade math matches Grading rules.md, TOL/中文 written as text, the
// embedded PNG is valid, and two identical exports are byte-identical.
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
let failures = 0;

const FROZEN_DATE = '2026-07-08T10:00:00';

// 19-column grid: A..D labels, then the 15-size run.
const SIZE_COLS = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'M2', 'L2', 'XL2', '2XL2', '3XL2', '4XL2', '5XL2'];
const COL_OF = Object.fromEntries(SIZE_COLS.map((label, i) => [label, 'EFGHIJKLMNOPQRS'[i]]));
const rowOfPom = (pom) => 3 + Number(pom); // POM 1 → row 4 … POM 16 → row 19

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  const baseUrl = started.baseUrl;
  cleanupTasks.push(() => new Promise((r) => server.close(r)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'export-xlsx-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));

  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `${baseUrl}/index.html?smoke=${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise((r) => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const session = await openCdpSession(cdpPort);
  await session.waitFor(`document.querySelectorAll('#specBody tr').length > 0`, 8000);

  // Fixture: one image (so the sketch embeds), Size L specs exercising each
  // grading family — band (1), direct 0.25-stepper (5), cup width with an
  // explicit Size L2 (10), held strap (14). POMs with no explicit spec now
  // fall back to their Tier-0 library suggestion (so POM 11 grades from its
  // corpus median); only POMs 15/16 (no library data) stay blank.
  const seeded = await session.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    if (!api || typeof api.exportSpecXlsxBase64 !== 'function') return { ok: false, reason: 'no export hook' };
    await api.loadProject({
      format: 'bra-sketch-project',
      version: 1,
      savedAt: '2026-07-08T00:00:00.000Z',
      state: {
        annotations: [],
        images: [{
          id: 1,
          dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          x: 0, y: 0, width: 200, height: 150, locked: false,
        }],
        eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'in' },
        nextSequence: 1, idCounter: 2,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0,
        styleId: 'TestStyle',
        pomSpecs: {
          '1':  { sizeL: '27.5', tol: '± 3/4' },
          '5':  { sizeL: '7.5', tol: '± 1/8', zh: '前中高测试' },
          '10': { sizeL: '5', sizeL2: '5.6', tol: '± 1/4' },
          '14': { sizeL: '14', tol: '± 1/4' },
        },
        gradeRules: {},
        depthRules: {},
      },
    });
    const a = await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)});
    const b = await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)});
    return { ok: true, a, b };
  })()`);
  check(seeded.ok, 'fixture seeded and workbook built', seeded.reason);
  if (!seeded.ok) throw new Error('cannot continue without a workbook');

  check(seeded.a === seeded.b, 'determinism: two exports with a frozen date are byte-identical');

  const zipBytes = Buffer.from(seeded.a, 'base64');
  const entries = unzipStore(zipBytes);

  // --- Parts present ---
  for (const name of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/_rels/sheet1.xml.rels',
    'xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels', 'xl/media/image1.png',
  ]) {
    check(!!entries[name], `part present: ${name}`);
  }

  const png = entries['xl/media/image1.png'];
  check(png && png.length > 8
    && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4E && png[3] === 0x47,
    'embedded image1.png has a valid PNG header');

  const sheet = entries['xl/worksheets/sheet1.xml'].toString('utf-8');

  // --- Header row exact, in order ---
  const headerLabels = ['POM', 'Description - English', 'Description - Chinese', 'TOL'].concat(SIZE_COLS);
  const row3 = sheet.match(/<row r="3"[^>]*>([\s\S]*?)<\/row>/)?.[1] || '';
  const gotHeaders = [...row3.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map(m => m[1]);
  check(JSON.stringify(gotHeaders) === JSON.stringify(headerLabels),
    'header row is exactly POM…5XL2 in order', 'got: ' + gotHeaders.join(' | '));

  // --- Title + style/date band ---
  check(inlineText(sheet, 'A1') === 'Measurement Spec', 'A1 title band');
  check(inlineText(sheet, 'A2') === 'TestStyle - 08.Jul.26', 'A2 styleId + frozen date', 'got: ' + inlineText(sheet, 'A2'));

  // --- POM 5 (direct 0.25-stepper): alpha from L, depth from derived L2 ---
  const r5 = rowOfPom(5);
  checkNum(sheet, 'E' + r5, 7.0, 'POM 5 S = protoL − 0.5');
  checkNum(sheet, 'G' + r5, 7.5, 'POM 5 L = protoL');
  checkNum(sheet, 'L' + r5, 8.5, 'POM 5 5XL = protoL + 1.0');
  checkNum(sheet, COL_OF.L2 + r5, 7.75, 'POM 5 L2 = protoL + 0.25 offset');
  checkNum(sheet, COL_OF.XL2 + r5, 8.0, 'POM 5 XL2 = protoL2 + 0.25');
  checkNum(sheet, COL_OF['3XL2'] + r5, 8.375, 'POM 5 3XL2 = protoL2 + 0.625 (depth taper, not alpha copy)');
  checkNum(sheet, COL_OF['4XL2'] + r5, 8.5, 'POM 5 4XL2 = protoL2 + 0.75');
  check(inlineText(sheet, 'D' + r5) === '± 1/8', 'POM 5 TOL written verbatim as text');
  check(inlineText(sheet, 'C' + r5) === '前中高测试', 'POM 5 中文 override in Chinese column');
  check(inlineText(sheet, 'B' + r5).length > 0, 'POM 5 English description non-empty (built-in fallback)');

  // --- Fractional VALUE display (Req 2): the size-value cells carry a custom
  // "# ??/??" number format so 3.75 renders as 3 3/4. Display-only: the
  // cached <v> stays decimal (every checkNum above still reads the decimal),
  // so Req-3 formula recalculation is unaffected. ---
  const styles = entries['xl/styles.xml'].toString('utf-8');
  check(styles.includes('<numFmt numFmtId="164" formatCode="# ??/??"/>'),
    'styles.xml declares the # ??/?? fraction numFmt (id 164)');
  // Find the fraction xf index robustly (don't hard-code): the cellXfs entry
  // that references numFmtId 164 with applyNumberFormat.
  const cellXfsBlock = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const xfs = [...cellXfsBlock.matchAll(/<xf\b[\s\S]*?(?:\/>|<\/xf>)/g)].map(m => m[0]);
  const fracXf = xfs.findIndex(x => x.includes('numFmtId="164"') && x.includes('applyNumberFormat="1"'));
  const plainNumXf = xfs.findIndex(x => x.includes('numFmtId="0"') && x.includes('horizontal="right"'));
  check(fracXf >= 0, 'a cellXfs entry uses numFmtId 164 with applyNumberFormat', 'fracXf=' + fracXf);
  // A data size cell (POM 5 Size-L, and a graded formula cell) must reference
  // the fraction xf, not the plain-number xf.
  const g5Style = cellStyle(sheet, 'G' + r5);
  const xl2Style = cellStyle(sheet, COL_OF.XL2 + r5);
  check(g5Style === fracXf && g5Style !== plainNumXf,
    'POM 5 static size cell G uses the fraction xf (not plain number)', 'got style ' + g5Style + ' want ' + fracXf);
  check(xl2Style === fracXf,
    'POM 5 formula size cell XL2 uses the fraction xf', 'got style ' + xl2Style + ' want ' + fracXf);

  // --- POM 1 (band): irregular alpha deltas; depth run equals alpha (offset 0) ---
  const r1 = rowOfPom(1);
  checkNum(sheet, 'E' + r1, 25.75, 'POM 1 S = protoL − 1.75');
  checkNum(sheet, 'I' + r1, 29.5, 'POM 1 2XL = protoL + 2.0');
  checkNum(sheet, COL_OF.M2 + r1, 26.5, 'POM 1 M2 = M (band L2 = L)');
  checkNum(sheet, COL_OF['5XL2'] + r1, 32.75, 'POM 1 5XL2 = protoL + 5.25');
  // Fraction TOL family (¾): TOL flows to Excel verbatim as text, so an
  // arbitrary "a/b" round-trips with no day→fraction map / conversion.
  check(inlineText(sheet, 'D' + r1) === '± 3/4', 'POM 1 TOL ± 3/4 fraction round-trips verbatim as text', 'got: ' + inlineText(sheet, 'D' + r1));

  // --- POM 10 (cup width): explicit Size L2 wins over derivation ---
  const r10 = rowOfPom(10);
  checkNum(sheet, 'G' + r10, 5, 'POM 10 L = protoL');
  checkNum(sheet, COL_OF.L2 + r10, 5.6, 'POM 10 L2 = explicit Size L2 input');
  checkNum(sheet, COL_OF.XL2 + r10, 6.1, 'POM 10 XL2 = explicit L2 + 0.5');
  checkNum(sheet, COL_OF['2XL2'] + r10, 7.1, 'POM 10 2XL2 = explicit L2 + 1.5');

  // --- Live grade formulas (Req 3): Size-L / L2 are static editable bases,
  // every other graded cell is a =G{r}±Δ / =N{r}±Δ formula. The cached <v>
  // (asserted above) is unchanged, so grade math and formulas stay in sync. ---
  check(!cellXml(sheet, 'G' + r5).includes('<f>'), 'POM 5 Size-L cell G is a static number (no formula)');
  check(cellFormula(sheet, 'E' + r5) === 'G' + r5 + '-0.5',
    'POM 5 S is a formula =G' + r5 + '-0.5', 'got: ' + cellFormula(sheet, 'E' + r5));
  check(cellFormula(sheet, COL_OF.XL2 + r5) === 'N' + r5 + '+0.25',
    'POM 5 XL2 is a depth formula =N' + r5 + '+0.25', 'got: ' + cellFormula(sheet, COL_OF.XL2 + r5));

  // POM 10 has an explicit Size L2 → its L2 cell is a static base, and its
  // depth cells anchor on it.
  check(!cellXml(sheet, COL_OF.L2 + r10).includes('<f>'),
    'POM 10 explicit L2 cell N is a static number (no formula)');
  check(cellFormula(sheet, COL_OF.XL2 + r10) === 'N' + r10 + '+0.5',
    'POM 10 XL2 is a depth formula =N' + r10 + '+0.5', 'got: ' + cellFormula(sheet, COL_OF.XL2 + r10));

  // --- POM 14 (held strap): flat across all 15 columns ---
  const r14 = rowOfPom(14);
  for (const label of ['S', 'L', '5XL', 'M2', 'L2', '5XL2']) {
    checkNum(sheet, COL_OF[label] + r14, 14, `POM 14 ${label} held at 14`);
  }
  // Held → Size-L is static, every other size cell is a flat =G{r} formula
  // (including the L2 cell, whose derived offset is 0).
  check(!cellXml(sheet, 'G' + r14).includes('<f>'), 'POM 14 Size-L cell G is a static number (no formula)');
  for (const label of SIZE_COLS) {
    if (label === 'L') continue;
    check(cellFormula(sheet, COL_OF[label] + r14) === 'G' + r14,
      `POM 14 ${label} is a flat formula =G${r14}`, 'got: ' + cellFormula(sheet, COL_OF[label] + r14));
  }

  // --- POM 16 (front apex): no library data and no line → every size cell blank ---
  const r16 = rowOfPom(16);
  check(cellNumber(sheet, 'E' + r16) === null && cellNumber(sheet, COL_OF['5XL2'] + r16) === null,
    'POM 16 (no library value, no line) has blank size cells');

  // --- POM 11 (no TD spec): now grades from its Tier-0 library suggestion ---
  const r11 = rowOfPom(11);
  check(cellNumber(sheet, 'G' + r11) != null && cellNumber(sheet, COL_OF['5XL2'] + r11) != null,
    'POM 11 (no TD Size L) grades from its library suggestion');

  // --- 18 POM rows, numbered 1..18 in the POM column ---
  for (let pom = 1; pom <= 18; pom += 1) {
    const v = cellNumber(sheet, 'A' + rowOfPom(pom));
    check(v === pom, `POM column row ${rowOfPom(pom)} = ${pom}`, 'got: ' + v);
  }

  // --- US-011: size-selective export (subset column layouts) ---
  // The hook's options.sizeSelection drives the same path as the picker
  // dialog. Column letters must re-derive from the SELECTED layout, formulas
  // must reference the relocated base columns, and a deselected base (L/L2)
  // must demote its dependents to cached static values (never a formula that
  // points at a column missing from the sheet).
  const subsets = await session.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    const alpha = ['S','M','L','XL','2XL','3XL','4XL','5XL'];
    const depth = ['M2','L2','XL2','2XL2','3XL2','4XL2','5XL2'];
    return {
      lOnly: await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)}, { image: false, sizeSelection: { alpha: ['L'], depth: [] } }),
      alphaOnly: await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)}, { image: false, sizeSelection: { alpha, depth: [] } }),
      depthOnly: await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)}, { image: false, sizeSelection: { alpha: [], depth } }),
      fullAgain: await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)}, { image: false }),
    };
  })()`);
  const sheetOf = (b64) => unzipStore(Buffer.from(b64, 'base64'))['xl/worksheets/sheet1.xml'].toString('utf-8');
  const headersOf = (sh) => {
    const row3 = sh.match(/<row r="3"[^>]*>([\s\S]*?)<\/row>/)?.[1] || '';
    return [...row3.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map(m => m[1]).slice(4);
  };

  // "Size L only": one size column (E), all values static, zero formulas.
  const shL = sheetOf(subsets.lOnly);
  check(JSON.stringify(headersOf(shL)) === JSON.stringify(['L']),
    'L-only export has exactly the L size column', 'got: ' + headersOf(shL).join('|'));
  check(!shL.includes('<f>'), 'L-only export has no formulas (base is the only size)');
  check(cellNumber(shL, 'E' + r5) === 7.5, 'L-only: POM 5 L value lands in column E',
    'got: ' + cellNumber(shL, 'E' + r5));
  check(shL.includes('<mergeCell ref="A1:E1"/>'), 'L-only: title merge spans A1:E1');

  // "Alpha only": L is the 3rd size column → base column G (same letter as
  // the full layout by coincidence of position); depth columns are gone.
  const shA = sheetOf(subsets.alphaOnly);
  check(headersOf(shA).length === 8 && !headersOf(shA).includes('M2'),
    'alpha-only export has the 8 alpha columns and no depth columns');
  check(cellFormula(shA, 'E' + r5) === 'G' + r5 + '-0.5',
    'alpha-only: POM 5 S formula anchors on the relocated L column (G)',
    'got: ' + cellFormula(shA, 'E' + r5));

  // "Depth only": L is deselected. L2 (derived from L) demotes to a static
  // cached value; the other depth cells stay live formulas anchored on the
  // relocated L2 column (2nd size column → F).
  const shD = sheetOf(subsets.depthOnly);
  check(JSON.stringify(headersOf(shD)) === JSON.stringify(['M2', 'L2', 'XL2', '2XL2', '3XL2', '4XL2', '5XL2']),
    'depth-only export has exactly the 7 depth columns', 'got: ' + headersOf(shD).join('|'));
  check(!cellXml(shD, 'F' + r5).includes('<f>'),
    'depth-only: POM 5 L2 (base L deselected) is a static cached value');
  check(cellNumber(shD, 'F' + r5) === 7.75, 'depth-only: POM 5 L2 cached value survives',
    'got: ' + cellNumber(shD, 'F' + r5));
  check(cellFormula(shD, 'G' + r5) === 'F' + r5 + '+0.25',
    'depth-only: POM 5 XL2 formula anchors on the relocated L2 column (F)',
    'got: ' + cellFormula(shD, 'G' + r5));

  // --- US-011 S3: per-size grading overrides (Grading dialog, gradeRules v2)
  // drive the export. An alpha override replaces the built-in delta in the
  // formula and the cached value; precedence beats the constant-step branch.
  const graded = await session.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    const st = api.exportProject().state;
    st.gradeRules = { version: 2, steps: {}, depthOffsets: {},
      alpha: { '5': { 'S': -1.25 } }, depth: { '5': { 'XL2': 1 } } };
    await api.loadProject({ format: 'bra-sketch-project', version: 1,
      savedAt: '2026-07-08T00:00:00.000Z', state: st });
    const b64 = await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)}, { image: false });
    // restore the un-graded fixture for any later sections
    st.gradeRules = { version: 2, steps: {}, alpha: {}, depth: {}, depthOffsets: {} };
    await api.loadProject({ format: 'bra-sketch-project', version: 1,
      savedAt: '2026-07-08T00:00:00.000Z', state: st });
    return b64;
  })()`);
  const shG = sheetOf(graded);
  check(cellFormula(shG, 'E' + r5) === 'G' + r5 + '-1.25',
    'per-size alpha override: POM 5 S formula becomes =G' + r5 + '-1.25',
    'got: ' + cellFormula(shG, 'E' + r5));
  check(cellNumber(shG, 'E' + r5) === 6.25,
    'per-size alpha override: POM 5 S cached value follows (7.5 - 1.25)',
    'got: ' + cellNumber(shG, 'E' + r5));
  check(cellFormula(shG, COL_OF.XL2 + r5) === 'N' + r5 + '+1',
    'per-size depth override: POM 5 XL2 formula becomes =N' + r5 + '+1',
    'got: ' + cellFormula(shG, COL_OF.XL2 + r5));

  // Restoring the hook's selection leaves the default full export unchanged:
  // byte-identical to the seeded no-image export path is not comparable here
  // (image differs), so assert the full 19-column span came back.
  check(sheetOf(subsets.fullAgain).includes('<mergeCell ref="A1:S1"/>'),
    'full export after subset exports still spans A1:S1 (selection restored)');

  // --- US-011 S4: custom POMs (19+) export with full parity ---
  // Core template now reserves 1..18 (US-037: neckline 17, armhole 18); the
  // first custom POM is 19.
  const custom = await session.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    const st = api.exportProject().state;
    st.customPoms = [{ pom: '19', en: 'Wing seam length', zh: '侧翼缝长' }];
    st.pomSpecs = Object.assign({}, st.pomSpecs, { '19': { sizeL: '6', tol: '± 1/4' } });
    await api.loadProject({ format: 'bra-sketch-project', version: 1,
      savedAt: '2026-07-08T00:00:00.000Z', state: st });
    const b64 = await api.exportSpecXlsxBase64(${JSON.stringify(FROZEN_DATE)}, { image: false });
    const roundTrip = api.exportProject().state.customPoms;
    return { b64, roundTrip };
  })()`);
  check(Array.isArray(custom.roundTrip) && custom.roundTrip.length === 1
    && custom.roundTrip[0].pom === '19',
    'customPoms survives the project save/load round-trip');
  const shC = sheetOf(custom.b64);
  const r19 = 3 + 19; // row 22, straight after POM 18
  check(cellNumber(shC, 'A' + r19) === 19, 'custom POM 19 row exports after POM 18',
    'got: ' + cellNumber(shC, 'A' + r19));
  check(inlineText(shC, 'B' + r19) === 'Wing seam length',
    'custom POM 19 English name from the registry', 'got: ' + inlineText(shC, 'B' + r19));
  check(inlineText(shC, 'C' + r19) === '侧翼缝长',
    'custom POM 19 中文 name from the registry', 'got: ' + inlineText(shC, 'C' + r19));
  check(cellNumber(shC, 'G' + r19) === 6, 'custom POM 19 Size L static base',
    'got: ' + cellNumber(shC, 'G' + r19));
  check(cellFormula(shC, 'E' + r19) === 'G' + r19,
    'custom POM 19 ungraded sizes are flat live formulas =G' + r19,
    'got: ' + cellFormula(shC, 'E' + r19));

  await session.close();
  if (failures > 0) {
    console.error(`FAIL  export-xlsx-tests: ${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('PASS  export-xlsx-tests');
  }
}

// ---- assertions ----

function check(cond, label, detail) {
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failures += 1;
    console.error('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

function checkNum(sheet, ref, expected, label) {
  const v = cellNumber(sheet, ref);
  check(v != null && Math.abs(v - expected) < 1e-9, label + ` [${ref}=${expected}]`, 'got: ' + v);
}

// ---- sheet xml helpers ----

function cellXml(sheet, ref) {
  // Match the opening tag first: [^>]* cannot cross '>', so a self-closing
  // blank cell ("<c .../>") never bleeds into the next cell's content.
  const open = sheet.match(new RegExp('<c r="' + ref + '"[^>]*>'));
  if (!open) return null;
  if (open[0].endsWith('/>')) return open[0];
  const rest = sheet.slice(open.index + open[0].length);
  return open[0] + rest.slice(0, rest.indexOf('</c>')) + '</c>';
}

function cellNumber(sheet, ref) {
  const xml = cellXml(sheet, ref);
  const m = xml && xml.match(/<v>([^<]*)<\/v>/);
  return m ? Number(m[1]) : null;
}

function cellFormula(sheet, ref) {
  const xml = cellXml(sheet, ref);
  const m = xml && xml.match(/<f>([^<]*)<\/f>/);
  return m ? m[1] : null;
}

function cellStyle(sheet, ref) {
  const xml = cellXml(sheet, ref);
  const m = xml && xml.match(/<c r="[^"]*" s="(\d+)"/);
  return m ? Number(m[1]) : null;
}

function inlineText(sheet, ref) {
  const xml = cellXml(sheet, ref);
  const m = xml && xml.match(/<t xml:space="preserve">([^<]*)<\/t>/);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : '';
}

// ---- minimal STORE-method unzip (read side of zipStore) ----

function unzipStore(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD — not a ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    if (method !== 0) throw new Error('expected STORE method for ' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    entries[name] = buf.subarray(start, start + compSize);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---- CDP plumbing (mirrors scripts/autosave-check.mjs) ----

async function openCdpSession(port) {
  let targets;
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const t = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return connectToTarget(t.webSocketDebuggerUrl);
    } catch (_) {}
    await sleep(80);
  }
  throw new Error('no page target available on CDP port ' + port);
}

async function connectToTarget(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const cdp = (method, params) => new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  const evalJs = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval failed');
    return res.result.value;
  };
  const waitFor = async (expression, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await evalJs(expression)) return; } catch (_) {}
      await sleep(80);
    }
    throw new Error('waitFor timeout: ' + expression);
  };
  return { eval: evalJs, waitFor, close: () => ws.close() };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForCdp(port) {
  for (let i = 0; i < 80; i += 1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch (_) {}
    await sleep(80);
  }
  throw new Error('CDP did not come up');
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
  return await res.json();
}

try {
  await main();
} catch (err) {
  if (process.exitCode == null) process.exitCode = 1;
  console.error('FAIL  export-xlsx-tests: ' + (err && err.message ? err.message : err));
} finally {
  for (const task of cleanupTasks.reverse()) {
    try { await task(); } catch (_) {}
  }
}
