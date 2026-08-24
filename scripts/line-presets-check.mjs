#!/usr/bin/env node
// US-096 / ADR 0055: the line-preset library, and stitch lines leaving the
// measurement set.
//
// The central claim is a NEGATIVE one — "this line is no longer counted" — and
// a negative is exactly what a state-shaped assertion proves badly: "the array
// is shorter" passes with the spec panel deleted, and "the id is missing from a
// filtered list" passes with the filter inverted everywhere at once. So every
// claim here is made against a surface a TD or a factory actually reads:
//
//   - the rendered Measurement Spec rows in the DOM,
//   - the bytes of the exported .xlsx worksheet,
//   - the pixels painted on #boardCanvas.
//
// The three disagree loudly if the filter is wired into only some of them,
// which is the realistic failure mode with nine call sites.
//
// Deliberately independent of demo/: the fixture image is generated in-page, so
// this suite also runs in the public mirror, which ships no sketches.
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
// Second code review, 2026-08-23: a reload wipes window.__lpErrors, so reading
// it only at the end gated the LAST page lifetime and silently discarded
// everything sections 1-8 collected. Drained before each reload and
// accumulated here instead.
const pageErrors = [];

const HARNESS = String.raw`
window.__LP = (() => {
  const d = window.__braAutoModeDebug;
  const canvas = document.getElementById('boardCanvas');
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))));

  const solidImage = (cssColor, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = cssColor;
    g.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  };

  // World -> backing-buffer pixels. dpr is READ off the live canvas rather than
  // assumed to be 1, so the suite stays honest on a HiDPI runner.
  const sample = (worldRect) => {
    const v = d.getView();
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const x = Math.round((worldRect.x * v.zoom + v.panX) * dpr);
    const y = Math.round((worldRect.y * v.zoom + v.panY) * dpr);
    const w = Math.max(1, Math.round(worldRect.width * v.zoom * dpr));
    const h = Math.max(1, Math.round(worldRect.height * v.zoom * dpr));
    if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) {
      return { offscreen: true, w: 0, h: 0, data: [] };
    }
    return { offscreen: false, w, h, data: canvas.getContext('2d').getImageData(x, y, w, h).data };
  };
  // Count pixels of the LINE COLOUR, not "any opaque pixel": the fixture sketch
  // is an opaque white rectangle, so an alpha test counts the backdrop and every
  // box comes back full.
  const redCount = (worldRect) => {
    const s = sample(worldRect);
    if (s.offscreen) return -1;
    let n = 0;
    for (let i = 0; i < s.data.length; i += 4) {
      if (Math.abs(s.data[i] - 230) <= 60 && Math.abs(s.data[i + 1] - 57) <= 60
        && Math.abs(s.data[i + 2] - 57) <= 60 && s.data[i + 3] > 120) n += 1;
    }
    return n;
  };
  // A box in SCREEN pixels around a world point, expressed back in world units.
  // The callout glyph is 17 screen px tall whatever the zoom, and it sits
  // 18 screen px off the line, so a screen-sized window is the only one that
  // stays clear of the line body at every zoom.
  const screenBox = (world, wPx, hPx) => {
    const z = d.getView().zoom;
    return { x: world.x - (wPx / 2) / z, y: world.y - (hPx / 2) / z, width: wPx / z, height: hPx / z };
  };

  const toClient = (wx, wy) => {
    const v = d.getView();
    const rect = canvas.getBoundingClientRect();
    return { x: wx * v.zoom + v.panX + rect.left, y: wy * v.zoom + v.panY + rect.top };
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

  // Draw a straight line the way a TD does: pick the tool, click both ends.
  // Escape drops the collinear-extension follow-up the second click arms, so
  // the next drawn line starts clean.
  // Clear the selection before any pixel read: a selected line also paints its
  // endpoint and label HANDLES in the line colour, right on top of the callout
  // glyph, so a selected board makes "is the number still there" unanswerable.
  const deselect = async () => {
    await click(8, 8);
    await settle();
  };

  const drawLine = async (x1, y1, x2, y2) => {
    document.getElementById('toolStraight').click();
    await settle();
    await click(x1, y1);
    await click(x2, y2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('toolSelect').click();
    await settle();
    const anns = d.getAnnotations();
    return anns[anns.length - 1];
  };

  const pickStitchStyle = async (style) => {
    document.getElementById('stitchesBtn').click();
    await settle();
    document.querySelector('#stitchesMenu [data-style="' + style + '"]').click();
    await settle();
  };

  // ui-status.js renders the POM/Stitch tag into #imageStatus, not #status.
  const modeTag = () => {
    const tag = document.querySelector('#imageStatus .mode-tag');
    return tag ? tag.textContent.trim() : null;
  };
  // data-pom-key is the row's identity (spec-row-builders.js sets it on every
  // built row); the first cell also carries the hide toggle, so its text is not
  // the label.
  const specRowKeys = () => Array.from(document.querySelectorAll('#specBody tr[data-pom-key]'))
    .map(tr => tr.dataset.pomKey);

  return { d, settle, solidImage, sample, redCount, screenBox, click, deselect, drawLine, pickStitchStyle, modeTag, specRowKeys };
})();
'ready'`;

// Re-installed after EVERY page load, including the reloads in section 8: the
// page-error gate at the end is worth nothing if nothing is collecting, and a
// reload wipes both the array and the listeners. Code review, 2026-08-23 — the
// gate previously read a global no file ever assigned, so it could not fail.
const ERROR_TRAP = String.raw`
window.__lpErrors = window.__lpErrors || [];
if (!window.__lpTrapInstalled) {
  window.__lpTrapInstalled = true;
  window.addEventListener('error', e => window.__lpErrors.push(String(e.message || e.type)));
  window.addEventListener('unhandledrejection', e => window.__lpErrors.push(
    'unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)));
}
'trapped'`;

// ---- minimal STORE unzip (read side of zipStore, as export-hidden-tests) ----
function unzipStore(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('no EOCD — not a ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n += 1) {
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + lName + lExtra;
    out[name] = buf.subarray(start, start + compSize);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Drain the page's error buffer into the node-side accumulator, then reload.
// Order matters: the drain has to happen while the OLD page is still alive.
async function reloadKeepingErrors(s, ERROR_TRAP) {
  pageErrors.push(...(await s.eval(`window.__lpErrors || []`)));
  await s.eval(`window.location.reload()`);
  await s.waitFor(`!!window.__braAutoModeDebug`, 20000);
  await s.eval(ERROR_TRAP);
}

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'line-presets-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  const pageUrl = `${started.baseUrl}/index.html?contract=linepresets${Date.now()}`;
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    // A RECOGNIZED test query param: without one a view-role prompt can block
    // the run and the harness hangs instead of failing.
    pageUrl,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`!!window.__braAutoModeDebug`, 20000);
  check(await s.eval(ERROR_TRAP) === 'trapped', 'the page-error trap did not install');

  // Refuse to run against a stale bundle. Every assertion below is about code
  // that only exists after US-096; a served-but-old app.js would report all of
  // it as broken and send the next reader hunting a phantom.
  const served = await s.eval(`(async () => {
    const src = document.querySelector('script[src*="app.js"]').getAttribute('src');
    const txt = await (await fetch(src)).text();
    const d = window.__braAutoModeDebug;
    return {
      src,
      isMeasurement: txt.includes('function isMeasurementAnnotation'),
      measurementSet: txt.includes('function measurementAnnotations'),
      showsCallout: txt.includes('function annotationShowsCallout'),
      consumeSeq: txt.includes('function consumePomSequenceFor'),
      pluralApply: txt.includes('function applyToSelectedAnnotations'),
      defaultStyle: txt.includes('function setDefaultLineStyle'),
      presetModel: txt.includes('function applyLinePreset'),
      presetPanel: txt.includes('function renderLinePresetList'),
      getMeasurementAnnIds: typeof d.getMeasurementAnnIds === 'function',
      getLinePresets: typeof d.getLinePresets === 'function',
      applyLinePreset: typeof d.applyLinePreset === 'function',
      importJson: typeof d.importLinePresetsJson === 'function',
      // The library lives INSIDE the Stitches menu (US-096 / US-082): no toolbar
      // unit of its own. Asserting the container relationship, not just the
      // element's existence, is what keeps a future refactor from quietly
      // spending a primary-surface slot again.
      presetListInStitchesMenu: !!document.querySelector('#stitchesMenu #linePresetList'),
      presetSaveInStitchesMenu: !!document.querySelector('#stitchesMenu #linePresetSaveBtn'),
      noStandalonePresetButton: !document.getElementById('linePresetBtn'),
    };
  })()`);
  for (const key of Object.keys(served)) {
    if (key === 'src') continue;
    check(served[key] === true, `the served bundle (${served.src}) predates US-096 — no ${key}. Run npm run build.`);
  }

  check(await s.eval(HARNESS) === 'ready', 'harness did not install');

  // Learning OFF before any synthetic edit: a suite that nudges lines around
  // otherwise feeds the anchor buckets and drifts the real detector.
  await s.eval(`window.__braAutoModeDebug.learning.setEnabled(false)`);

  // ---- Setup: one white sketch, Manual Mode --------------------------------
  await s.eval(`(async () => {
    const { d, settle, solidImage } = window.__LP;
    await d.addBoardImages([solidImage('#ffffff', 640, 420)]);
    document.getElementById('modeManualBtn').click();
    await settle();
    return true;
  })()`);

  // ---- 1. The truth table, read through the measurement set ----------------
  //
  // Pushed directly rather than drawn: this is about the PREDICATE, and six
  // hand-drawn lines would only add ways for the setup to fail.
  const roles = await s.eval(`(async () => {
    const { d, settle } = window.__LP;
    const img = d.getImages()[0];
    const mk = (style, text, i) => ({
      id: 9000 + i, seq: 90 + i, type: 'straight', style, color: 'red',
      arrowType: 'none', lineWidth: 2.5,
      start: { x: img.x + 40, y: img.y + 30 + i * 18 },
      end: { x: img.x + 200, y: img.y + 30 + i * 18 },
      control1: null, control2: null, points: [],
      label: { x: img.x + 120, y: img.y + 24 + i * 18 }, labelManual: false,
      text, value: null, sourceImageId: img.id,
    });
    const cases = [
      ['solid', null], ['dashed', null], ['zigzag', null], ['cover', null],
      ['bartack', null], ['zigzag', '8'], ['zigzag', '   '], ['nonsense-style', null],
    ];
    cases.forEach(([style, text], i) => d.styleEvidence.pushAnnotation(mk(style, text, i)));
    await settle();
    const measured = new Set(d.getMeasurementAnnIds());
    const drawn = new Set(d.getAnnotations().map(a => a.id));
    const exported = new Set(d.getExportAnnIds());
    return cases.map(([style, text], i) => ({
      style, text,
      measured: measured.has(9000 + i),
      onBoard: drawn.has(9000 + i),
      exported: exported.has(9000 + i),
    }));
  })()`);
  const want = [true, true, false, false, false, true, false, true];
  roles.forEach((row, i) => {
    check(row.measured === want[i],
      `truth table: ${row.style}${row.text ? ` labelled ${JSON.stringify(row.text)}` : ''} should be `
      + `${want[i] ? '' : 'NOT '}a measurement, got measured=${row.measured}`);
  });
  check(roles.every(r => r.onBoard), 'every line, construction included, must stay on the board');
  check(roles.every(r => r.exported), 'a construction line is still DRAWN — it must stay in the visual export set');

  // ---- 2. The Measurement Spec panel ---------------------------------------
  //
  // Read the RENDERED rows, not the filtered list they came from. The panel is
  // what a TD reads, and it has its own membership rule (template rows, custom
  // POMs, extras) that a correct filter could still be wired past.
  const specRows = await s.eval(`(async () => {
    const { settle, specRowKeys } = window.__LP;
    // The panel is fingerprint-guarded and rebuilds on updateUI, not on a bare
    // resize — clicking a tool is the cheapest honest way to ask for one.
    document.getElementById('toolSelect').click();
    await settle();
    const keys = specRowKeys();
    const labelledRow = document.querySelector('#specBody tr[data-ann-id="9005"]');
    return { keys, labelledPomKey: labelledRow ? labelledRow.dataset.pomKey : null };
  })()`);
  for (const key of ['90', '91', '97']) {
    check(specRows.keys.includes(key),
      `a plain/dashed line owns a spec row: ${key} missing from ${JSON.stringify(specRows.keys)}`);
  }
  for (const key of ['92', '93', '94', '96']) {
    check(!specRows.keys.includes(key),
      `a construction line owns NO spec row: ${key} still rendered in ${JSON.stringify(specRows.keys)}`);
  }
  check(specRows.labelledPomKey === '8',
    `the LABELLED zigzag keeps its row under its own POM number — the deliberate exception `
    + `(got ${JSON.stringify(specRows.labelledPomKey)})`);

  // ---- 3. The exported workbook -------------------------------------------
  //
  // The workbook's rows come from the POM template, not from the lines, so
  // "a stray row appeared" is the wrong thing to look for. The reachable
  // damage is the opposite and worse: US-047 records a DELETED line's POM key
  // and drops that row from the sheet. A construction mark born on sequence
  // number 5 therefore used to be able to delete POM 5 out of the factory
  // workbook by being erased.
  const pomRowsFor = async (label) => {
    const b64 = await s.eval(
      `window.__braAutoModeDebug.exportSpecXlsxBase64('2026-08-23T10:00:00', { image: false })`);
    const xml = unzipStore(Buffer.from(b64, 'base64'))['xl/worksheets/sheet1.xml'].toString('utf8');
    const out = [];
    const re = /<c r="A(\d+)"[^>]*>\s*<v>(\d+)<\/v>/g;
    let m;
    while ((m = re.exec(xml))) out.push(Number(m[2]));
    check(out.length > 0, `${label}: the exported sheet has no POM rows at all`);
    return out;
  };

  const baselineRows = await pomRowsFor('baseline');
  check(baselineRows.includes(5), `precondition: POM 5 is in the exported sheet (${baselineRows.join(',')})`);

  const afterDelete = await s.eval(`(async () => {
    const { d, settle, click } = window.__LP;
    const img = d.getImages()[0];
    // A stitch mark that happens to be sitting on sequence number 5.
    d.styleEvidence.pushAnnotation({
      id: 9500, seq: 5, type: 'straight', style: 'zigzag', color: 'red',
      arrowType: 'none', lineWidth: 2.5,
      start: { x: img.x + 300, y: img.y + 240 }, end: { x: img.x + 400, y: img.y + 240 },
      control1: null, control2: null, points: [],
      label: { x: img.x + 350, y: img.y + 232 }, labelManual: false,
      text: null, value: null, sourceImageId: img.id,
    });
    await settle();
    await click(img.x + 350, img.y + 240);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle();
    return {
      gone: !d.getAnnotations().some(a => a.id === 9500),
    };
  })()`);
  check(afterDelete.gone === true,
    'precondition: the construction mark was actually selected and deleted');

  const rowsAfterDelete = await pomRowsFor('after deleting a construction mark');
  check(rowsAfterDelete.includes(5),
    `deleting a construction mark must not delete POM 5 from the workbook `
    + `(rows: ${rowsAfterDelete.join(',')})`);
  check(rowsAfterDelete.length === baselineRows.length,
    `deleting a construction mark changes no workbook row count `
    + `(${baselineRows.length} -> ${rowsAfterDelete.length})`);

  // ---- 4. Callout pixels ---------------------------------------------------
  //
  // A PIXEL claim, deliberately. "No measurement row" is provable from the DOM,
  // but "no callout number" means the glyph is not painted, and no amount of
  // filtering in the panel would show that.
  //
  // Drawn well clear of the section-1 fixtures. Those sit in a stack at
  // x 314..474, and a bartack's stitches reach ~4.7 world px either side of its
  // path — enough to fill a glyph box two rows away and make every reading
  // meaningless. The control below is what caught that, and it stays in as the
  // precondition rather than being replaced by a comment.
  const callout = await s.eval(`(async () => {
    const { d, settle, redCount, screenBox, drawLine, deselect } = window.__LP;
    // Clear the section-1 fixtures off the board first. They are stacked 18 px
    // apart, and a bartack's stitches reach ~4.7 world px either side of their
    // path, so a neighbour two rows away fills the glyph box on its own — the
    // control below caught exactly that.
    //
    // DELETED, not hidden: since the code review a construction line cannot be
    // hidden at all (isAnnHidden is now role-aware, so hiding cannot strand a
    // line with no row left to un-hide it from), which is precisely why hiding
    // them stopped clearing the board.
    for (const a of d.getAnnotations()) d.styleEvidence.simulateTdDelete(a.id);
    await settle();
    const line = await drawLine(320, 300, 470, 300);
    await deselect();
    const glyphBox = screenBox(line.label, 26, 15);
    const bodyBox = screenBox({ x: (line.start.x + line.end.x) / 2, y: line.start.y }, 40, 9);
    const glyph = redCount(glyphBox);
    const body = redCount(bodyBox);
    // Control: with this line hidden, both windows must be empty — proof the
    // readings above belong to this line and nothing else.
    d.setHiddenAnnIds([line.id]);
    await settle();
    const strayGlyph = redCount(glyphBox);
    const strayBody = redCount(bodyBox);
    d.setHiddenAnnIds([]);
    await settle();
    return { id: line.id, glyphBox, bodyBox, glyph, body, strayGlyph, strayBody };
  })()`);
  check(callout.strayGlyph === 0 && callout.strayBody === 0,
    `control: with the line hidden both pixel windows must be empty — otherwise another `
    + `line is painting into them and every reading below is noise `
    + `(glyph ${callout.strayGlyph}, body ${callout.strayBody})`);
  check(callout.glyph > 0, `a plain line paints its callout number (got ${callout.glyph} red pixels)`);
  check(callout.body > 0, `precondition: the line body itself is painted (got ${callout.body} red pixels)`);

  const afterConvert = await s.eval(`(async () => {
    const { d, redCount, click } = window.__LP;
    const line = d.getAnnotations().find(a => a.id === ${callout.id});
    // Selected with a REAL click and restyled through the REAL menu: the
    // selection path is exactly where the board-mode defect lived, so calling
    // the handler directly would assert nothing about it.
    await click((line.start.x + line.end.x) / 2, line.start.y);
    const modeBefore = window.__LP.modeTag();
    await window.__LP.pickStitchStyle('zigzag');
    const modeAfter = window.__LP.modeTag();
    await window.__LP.deselect();
    return {
      styleNow: d.getAnnotations().find(a => a.id === ${callout.id}).style,
      glyph: redCount(${JSON.stringify(callout.glyphBox)}),
      body: redCount(${JSON.stringify(callout.bodyBox)}),
      modeBefore,
      modeAfter,
      measured: d.getMeasurementAnnIds().includes(${callout.id}),
    };
  })()`);
  check(afterConvert.styleNow === 'zigzag',
    `selecting a line and picking Zigzag converts it (got ${afterConvert.styleNow})`);
  check(afterConvert.glyph === 0,
    `a converted line stops painting its callout number (still ${afterConvert.glyph} red pixels in the glyph box)`);
  check(afterConvert.body > 0,
    `...and is still DRAWN as a stitch — the glyph must vanish, not the line `
    + `(body box has ${afterConvert.body} red pixels)`);
  check(afterConvert.measured === false, 'a converted line leaves the measurement set');

  // ---- 5. The board's mode is not collateral damage ------------------------
  check(afterConvert.modeBefore === 'POM',
    `precondition: the board is in POM mode before the conversion (was ${afterConvert.modeBefore})`);
  check(afterConvert.modeAfter === 'POM',
    `applying a stitch style TO A SELECTION must not switch the board to Stitch mode `
    + `(mode became ${afterConvert.modeAfter}) — that is what used to blank every callout on the board`);

  const defaultStyleMode = await s.eval(`(async () => {
    const { settle } = window.__LP;
    // Nothing selected: now the same menu SHOULD switch the board's mode.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('boardCanvas').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 5, clientY: 5 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 5, clientY: 5 }));
    await settle();
    await window.__LP.pickStitchStyle('bartack');
    const stitch = window.__LP.modeTag();
    await window.__LP.pickStitchStyle('solid');
    return { stitch, back: window.__LP.modeTag() };
  })()`);
  check(defaultStyleMode.stitch === 'Stitch',
    `with nothing selected the Stitches menu still sets the DEFAULT and switches to Stitch mode (got ${defaultStyleMode.stitch})`);
  check(defaultStyleMode.back === 'POM', 'and back to POM mode when a plain style is chosen');

  // ---- 6. A preset applies to the WHOLE selection --------------------------
  const group = await s.eval(`(async () => {
    const { d, settle, drawLine, click } = window.__LP;
    const a = await drawLine(60, 340, 180, 340);
    const b = await drawLine(60, 365, 180, 365);
    const c = await drawLine(60, 390, 180, 390);
    await click(120, 340);
    await click(120, 365, { shiftKey: true });
    await click(120, 390, { shiftKey: true });
    await settle();
    const zig = d.getLinePresets().find(p => p.style === 'zigzag');
    d.applyLinePreset(zig.id);
    await settle();
    const byId = new Map(d.getAnnotations().map(x => [x.id, x]));
    return {
      preset: zig.name,
      styles: [a.id, b.id, c.id].map(id => byId.get(id).style),
      colors: [a.id, b.id, c.id].map(id => byId.get(id).color),
      mode: window.__LP.modeTag(),
    };
  })()`);
  check(group.styles.join(',') === 'zigzag,zigzag,zigzag',
    `a preset applies to every selected line, not just the primary (got ${group.styles.join(',')})`);
  check(new Set(group.colors).size === 1 && group.colors[0] === 'blue',
    `a preset carries its colour too (got ${JSON.stringify(group.colors)})`);
  check(group.mode === 'POM', 'applying a preset to a selection leaves the board mode alone');

  // ---- 7. Construction lines spend no POM number ---------------------------
  //
  // The visible symptom this fixes: draw a POM line, mark three stitches, and
  // the next real line used to come out numbered 5.
  const numbering = await s.eval(`(async () => {
    const { d, settle, drawLine, deselect, pickStitchStyle } = window.__LP;
    // Deselect FIRST. With lines still selected the Stitches menu restyles them
    // instead of setting the default (that split is US-096's whole point), the
    // lines below would be drawn plain, and this section would silently be
    // testing nothing.
    await deselect();
    await pickStitchStyle('zigzag');
    const defaultStyle = window.__LP.modeTag();
    const s1 = await drawLine(300, 60, 380, 60);
    const s2 = await drawLine(300, 80, 380, 80);
    const s3 = await drawLine(300, 100, 380, 100);
    await deselect();
    await pickStitchStyle('solid');
    const m = await drawLine(300, 130, 380, 130);
    await settle();
    return {
      defaultStyle,
      stitchStyles: [s1.style, s2.style, s3.style],
      stitchSeqs: [s1.seq, s2.seq, s3.seq],
      measurementStyle: m.style,
      measurementSeq: m.seq,
    };
  })()`);
  check(numbering.defaultStyle === 'Stitch',
    `precondition: with nothing selected the menu sets the DEFAULT (board should read Stitch, read ${numbering.defaultStyle})`);
  check(numbering.stitchStyles.join(',') === 'zigzag,zigzag,zigzag',
    `precondition: the three marks were actually drawn as stitches (got ${numbering.stitchStyles.join(',')})`);
  check(numbering.measurementStyle === 'solid',
    `precondition: the fourth line was drawn plain (got ${numbering.measurementStyle})`);
  check(new Set(numbering.stitchSeqs).size === 1,
    `three consecutive stitch marks spend no POM number between them (got seqs ${JSON.stringify(numbering.stitchSeqs)})`);
  check(numbering.measurementSeq === numbering.stitchSeqs[0],
    `the next measurement line reuses the number the stitch marks did not spend `
    + `(stitch seq ${numbering.stitchSeqs[0]}, measurement seq ${numbering.measurementSeq})`);

  // ---- 7b. Conversion BACK, and the POM-number invariant -------------------
  //
  // Code review, 2026-08-23: every conversion the suite drove ran measurement ->
  // construction, so the reverse branch was never executed at all.
  //
  // The state that breaks it has to be built deliberately, and getting this
  // wrong is easy: a construction line that ALREADY shares its seq with a
  // measurement line is repaired even by the naive "reissue only on conflict"
  // rule, so a scenario like that passes with the defect fully in place. The
  // damaging case is the opposite one — a LONE stitch mark, holding the
  // counter's current value with nothing else on it. Nothing conflicts at the
  // moment of conversion, so a conditional reissue does nothing, the counter
  // never advances, and the next drawn line is stamped with the same number.
  const backConversion = await s.eval(`(async () => {
    const { d, settle, deselect, drawLine, pickStitchStyle, click } = window.__LP;
    await deselect();
    // A lone stitch mark on a fresh number.
    await pickStitchStyle('zigzag');
    const mark = await drawLine(300, 150, 380, 150);
    await deselect();
    const collidesAtConversion = d.getAnnotations()
      .some(a => a.id !== mark.id && a.seq === mark.seq && d.getMeasurementAnnIds().includes(a.id));
    // Put the BOARD default back to a measurement style first, so the board is
    // in POM mode before the conversion. Otherwise "mode unchanged" would be
    // Stitch -> Stitch and prove nothing about the selection/default split.
    await pickStitchStyle('solid');
    // Convert it back through the real path.
    await click((mark.start.x + mark.end.x) / 2, mark.start.y);
    const modeBefore = window.__LP.modeTag();
    await pickStitchStyle('solid');
    const modeAfter = window.__LP.modeTag();
    const converted = d.getAnnotations().find(a => a.id === mark.id);
    // ...then draw the next measurement line.
    await deselect();
    const fresh = await drawLine(300, 175, 380, 175);
    await settle();
    const measurement = d.getAnnotations().filter(a => d.getMeasurementAnnIds().includes(a.id));
    return {
      collidesAtConversion,
      style: converted.style,
      nowMeasured: d.getMeasurementAnnIds().includes(mark.id),
      bornSeq: mark.seq,
      convertedSeq: converted.seq,
      freshSeq: fresh.seq,
      measurementCount: measurement.length,
      uniqueSeqs: new Set(measurement.map(a => a.seq)).size,
      seqs: measurement.map(a => a.seq),
      modeBefore, modeAfter,
    };
  })()`);
  check(backConversion.collidesAtConversion === false,
    `precondition: the stitch mark must NOT already share its number with a measurement `
    + `line, or a conditional reissue would repair it and this section proves nothing`);
  check(backConversion.style === 'solid' && backConversion.nowMeasured,
    `converting a construction line back to Plain returns it to the measurement set `
    + `(style ${backConversion.style}, measured ${backConversion.nowMeasured})`);
  check(backConversion.modeBefore === 'POM' && backConversion.modeAfter === 'POM',
    `converting back with a selection still leaves the board mode alone `
    + `(${backConversion.modeBefore} -> ${backConversion.modeAfter})`);
  check(backConversion.freshSeq !== backConversion.convertedSeq,
    `the line drawn AFTER a conversion must not reuse the converted line's POM number `
    + `(both came out as ${backConversion.convertedSeq}) — every consumer does `
    + `annByPom.set(getLabelText(ann), ann), so the second line silently replaces the `
    + `first in the spec panel and in both workbooks`);
  check(backConversion.uniqueSeqs === backConversion.measurementCount,
    `no two MEASUREMENT lines may share a POM number `
    + `(seqs ${JSON.stringify(backConversion.seqs)})`);

  // ---- 7b2. A ROUND TRIP must not destroy the line's POM identity ----------
  //
  // The other direction of 7b, and the one a TD actually meets: an existing POM
  // line restyled to a stitch by mistake, then restyled straight back.
  //
  // Second code review, 2026-08-23. The first fix for 7b's collision reissued
  // UNCONDITIONALLY, which satisfies uniqueness and quietly renumbers POM 8 to
  // POM 19 — same red line, same geometry, new number, POM 8's row emptied in
  // both workbooks. An auto-applied line carries text:null, so its seq IS its
  // POM identity. Section 7b could not see it because it only ever drove a line
  // BORN as construction, where there is no identity to preserve.
  const styleRoundTrip = await s.eval(`(async () => {
    const { d, settle, deselect, drawLine, pickStitchStyle, click } = window.__LP;
    await deselect();
    await pickStitchStyle('solid');
    const line = await drawLine(300, 200, 380, 200);
    const originalSeq = line.seq;
    // Advance the counter past it, exactly as an Apply Lines run leaves it.
    await deselect();
    await drawLine(300, 220, 380, 220);
    await deselect();
    const counterMoved = d.getAnnotations().some(a => a.seq > originalSeq);
    // Restyle it to a stitch, then straight back.
    await click((line.start.x + line.end.x) / 2, line.start.y);
    await pickStitchStyle('zigzag');
    const asStitch = d.getAnnotations().find(a => a.id === line.id);
    await pickStitchStyle('solid');
    const back = d.getAnnotations().find(a => a.id === line.id);
    await deselect();
    // And the next drawn line must still not collide with it.
    const next = await drawLine(300, 240, 380, 240);
    const measurement = d.getAnnotations().filter(a => d.getMeasurementAnnIds().includes(a.id));
    return {
      counterMoved,
      originalSeq,
      wasConstruction: !d.getMeasurementAnnIds().includes(line.id) || asStitch.style === 'zigzag',
      stitchStyle: asStitch.style,
      backSeq: back.seq,
      backStyle: back.style,
      nextSeq: next.seq,
      uniqueSeqs: new Set(measurement.map(a => a.seq)).size === measurement.length,
      seqs: measurement.map(a => a.seq),
    };
  })()`);
  check(styleRoundTrip.counterMoved === true,
    'precondition: state.nextSequence has moved past the line under test, or a reissue '
    + 'would be indistinguishable from keeping the number');
  check(styleRoundTrip.stitchStyle === 'zigzag' && styleRoundTrip.backStyle === 'solid',
    `precondition: the line really went Plain -> Zigzag -> Plain `
    + `(${styleRoundTrip.stitchStyle} -> ${styleRoundTrip.backStyle})`);
  check(styleRoundTrip.backSeq === styleRoundTrip.originalSeq,
    `a POM line restyled to a stitch and straight back must KEEP its POM number. An `
    + `auto-applied line carries text:null, so its seq IS its identity — renumbering it `
    + `empties that POM's row in both workbooks while the line still sits on the sketch `
    + `(was ${styleRoundTrip.originalSeq}, came back as ${styleRoundTrip.backSeq})`);
  check(styleRoundTrip.nextSeq !== styleRoundTrip.backSeq,
    `...and the next drawn line still must not collide with it `
    + `(both ${styleRoundTrip.backSeq})`);
  check(styleRoundTrip.uniqueSeqs === true,
    `no two measurement lines share a number after the round trip `
    + `(seqs ${JSON.stringify(styleRoundTrip.seqs)})`);

  // ---- 7b3. The label editor must not hand the TD a colliding number -------
  //
  // Second code review, 2026-08-23. The label editor commits on BLUR, and it
  // pre-filled getLabelText(ann) — which for a construction line is the seq it
  // was born with, and by design that seq is exactly the number the next
  // measurement line will take. So a stray double-click on a stitch mark plus a
  // click anywhere else silently fired the ADR's "a labelled stitch line still
  // measures" exception with a guaranteed-duplicate key. Zero keystrokes.
  const labelEditor = await s.eval(`(async () => {
    const { d, settle, deselect, drawLine, pickStitchStyle } = window.__LP;
    await deselect();
    await pickStitchStyle('zigzag');
    const mark = await drawLine(300, 260, 380, 260);
    await deselect();
    await pickStitchStyle('solid');
    const bornSeq = mark.seq;
    const isConstruction = !d.getMeasurementAnnIds().includes(mark.id);

    // Double-click its BODY (the label test is gated; the body test is not).
    const canvas = document.getElementById('boardCanvas');
    const v = d.getView();
    const r = canvas.getBoundingClientRect();
    const mid = { x: (mark.start.x + mark.end.x) / 2, y: mark.start.y };
    const p = { x: mid.x * v.zoom + v.panX + r.left, y: mid.y * v.zoom + v.panY + r.top };
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: p.x, clientY: p.y, bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: p.x, clientY: p.y, bubbles: true, button: 0 }));
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: p.x, clientY: p.y, bubbles: true, button: 0 }));
    await settle();
    const editor = document.getElementById('labelEditor');
    const opened = editor && editor.style.display === 'block';
    const prefilled = editor ? editor.value : null;
    // Commit by blur, the accidental path.
    editor.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle();
    const after = d.getAnnotations().find(a => a.id === mark.id);
    return {
      bornSeq, isConstruction, opened, prefilled,
      textAfter: after ? after.text : null,
      stillConstruction: !d.getMeasurementAnnIds().includes(mark.id),
    };
  })()`);
  check(labelEditor.isConstruction === true,
    'precondition: the mark was drawn as a construction line');
  check(labelEditor.opened === true,
    'precondition: double-clicking its body did open the label editor — if it did not, '
    + 'the assertions below prove nothing');
  check(labelEditor.prefilled === '',
    `a construction line paints no callout, so the editor must open EMPTY. Pre-filling `
    + `getLabelText(ann) hands over the seq it was born with, which is exactly the number `
    + `the next measurement line takes (got ${JSON.stringify(labelEditor.prefilled)})`);
  check(labelEditor.textAfter === null && labelEditor.stillConstruction === true,
    `...so committing by blur — the accidental path, zero keystrokes — changes nothing. `
    + `It used to write that number as a manual POM label, firing the ADR's deliberate `
    + `exception by accident and putting two measurement lines on one POM key `
    + `(text ${JSON.stringify(labelEditor.textAfter)})`);

  // ---- 7c. The consumers the Board page cannot show ------------------------
  //
  // The three surfaces above are all fed from the Board. These are the rest of
  // the measurement-set call sites, and the suite's own premise (see the header)
  // is that the realistic failure is a filter wired into only some of them.
  const otherConsumers = await s.eval(`(async () => {
    const { d, settle } = window.__LP;
    const img = d.getImages()[0];
    const mk = (id, seq, style, y) => d.styleEvidence.pushAnnotation({
      id, seq, type: 'straight', style, color: 'red',
      arrowType: 'none', lineWidth: 2.5,
      start: { x: img.x + 120, y: img.y + y }, end: { x: img.x + 260, y: img.y + y },
      control1: null, control2: null, points: [],
      label: { x: img.x + 190, y: img.y + y - 8 }, labelManual: false,
      text: null, value: null, sourceImageId: img.id,
    });
    // POM 11 as a construction mark, POM 12 as a real measurement line. Every
    // consumer below must tell them apart.
    mk(9600, 11, 'cover', 200);
    mk(9601, 12, 'solid', 220);
    await settle();

    // --- Preview page ------------------------------------------------------
    // Its POM rows come from the template, not from the lines, so "a stray row
    // appeared" is the wrong thing to look for here — exactly as in section 3.
    //
    // And comparing Preview's row set to the workbook's proves nothing: both
    // call the same specVisiblePomKeys(), so they are equal by construction.
    // The ONE route by which Preview's own annByPom changes its row set is
    // US-047's rule that a DELETED POM is dropped "unless a line with that
    // label has since been redrawn" — implemented as
    // "if (!annByPom.has(key)) hiddenPomKeys.add(key)". Put a construction mark
    // on the deleted POM's number: with the filter in place annByPom does not
    // have the key and POM 7 is dropped; without it, the stitch mark
    // masquerades as the redrawn line and POM 7 comes back.
    // Deleted through the REAL path: simulateTdDelete bypasses deletedPomKeys,
    // which is the whole mechanism under test here. Selected through its spec
    // ROW rather than a canvas click — the row is a deterministic target, and
    // a missed click would make the whole section vacuous.
    // Pick a POM number nothing on the board is already using. Hard-coding one
    // is how the first version of this section failed: the suite drives ONE
    // long-lived board, and by section 7c the earlier sections have already
    // taken low sequence numbers, so a line already answered to the chosen key
    // and specVisiblePomKeys never dropped it.
    const usedKeys = new Set(d.getAnnotations()
      .filter(a => d.getMeasurementAnnIds().includes(a.id))
      .map(a => String(a.text != null && String(a.text).trim() !== '' ? a.text : a.seq)));
    let freeKey = 0;
    for (let k = 18; k >= 1; k -= 1) { if (!usedKeys.has(String(k))) { freeKey = k; break; } }
    mk(9603, freeKey, 'solid', 240);
    document.getElementById('toolSelect').click();
    await settle();
    const pomRow = document.querySelector('#specBody tr[data-ann-id="9603"]');
    if (pomRow) pomRow.click();
    await settle();
    const selectedForDelete = pomRow && document
      .querySelector('#specBody tr[data-ann-id="9603"]').classList.contains('selected');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle();
    const deleted = !d.getAnnotations().some(a => a.id === 9603);
    // ...and a construction mark left sitting on that same POM number.
    mk(9604, freeKey, 'zigzag', 244);
    document.getElementById('toolSelect').click();
    await settle();

    document.querySelector('#pageTabBar [data-page="preview"]').click();
    await settle(); await settle();
    const previewPomKeys = Array.from(document.querySelectorAll('#previewPage table.pv-spec tbody tr'))
      .map(tr => (tr.querySelector('td') || {}).textContent)
      .map(t => String(t == null ? '' : t).trim());
    document.querySelector('#pageTabBar [data-page="board"]').click();
    await settle();
    return { previewPomKeys, selectedForDelete, deleted, freeKey, usedKeys: [...usedKeys],
      previewDropsDeletedPom: freeKey > 0 && !previewPomKeys.includes(String(freeKey)) };
  })()`);
  check(otherConsumers.previewPomKeys.length > 0,
    'precondition: the Preview page rendered a POM table at all');
  check(otherConsumers.freeKey > 0,
    `precondition: a POM number nothing else answers to was available `
    + `(used: ${JSON.stringify(otherConsumers.usedKeys)})`);
  check(otherConsumers.selectedForDelete === true,
    `precondition: clicking the POM ${otherConsumers.freeKey} spec row selected its line`);
  check(otherConsumers.deleted === true,
    `precondition: that line was actually deleted, so deletedPomKeys carries ${otherConsumers.freeKey}`);
  check(otherConsumers.previewDropsDeletedPom === true,
    `the Preview page must drop a POM whose line was deleted, even when a construction `
    + `mark is sitting on that same number. This is the ONE way Preview's own annByPom can `
    + `change its row set (specVisiblePomKeys re-includes a deleted POM when annByPom still `
    + `has the key), so it is the only assertion that can tell Preview's filter from the `
    + `workbook's — comparing the two row sets cannot: both call the same `
    + `specVisiblePomKeys(), so they are equal by construction whatever Preview does\n`
    + `  POM ${otherConsumers.freeKey} was deleted and a stitch mark left on that number\n`
    + `  preview rows: ${JSON.stringify(otherConsumers.previewPomKeys)}`);
  const workbookPomKeys = (await pomRowsFor('preview cross-check')).map(String);
  check(!workbookPomKeys.includes(String(otherConsumers.freeKey)),
    `control: the workbook drops POM ${otherConsumers.freeKey} too (rows ${workbookPomKeys.join(',')})`);

  // Hide-all and the learning funnel, read AFTER the cross-check above — hiding
  // changes the exported row set, so the two readings cannot share a moment.
  const hideAndLearn = await s.eval(`(async () => {
    const { d, settle } = window.__LP;

    // --- Hide all POMs ------------------------------------------------------
    const hideAll = Array.from(document.querySelectorAll('#specBody button'))
      .find(b => /Hide all/i.test(b.textContent || ''));
    const hadHideAll = !!hideAll;
    if (hideAll) hideAll.click();
    await settle();
    const exportedAfterHideAll = d.getExportAnnIds();

    // --- The LIVE TD-edit learning funnel -----------------------------------
    d.learning.setEnabled(true);
    const construction = d.learning.evaluateManualPomSample(9600, { allowAuto: true });
    const measurement = d.learning.evaluateManualPomSample(9601, { allowAuto: true });
    d.learning.setEnabled(false);

    return {
      hadHideAll,
      constructionStillDrawn: exportedAfterHideAll.includes(9600),
      measurementHidden: !exportedAfterHideAll.includes(9601),
      constructionVerdict: construction && construction.status,
      measurementVerdict: measurement && measurement.status,
    };
  })()`);
  check(hideAndLearn.hadHideAll === true,
    'precondition: the Hide-all control rendered, or the next two checks are vacuous');
  check(hideAndLearn.measurementHidden === true,
    '"Hide all POMs" does hide a real measurement line');
  check(hideAndLearn.constructionStillDrawn === true,
    '"Hide all POMs" must NOT hide a construction line — it is not a POM, and hiding it '
    + 'would strand it with no spec row left to un-hide it from');
  check(hideAndLearn.measurementVerdict !== 'skipped',
    `control: the live TD-edit learning funnel does return a verdict for a measurement `
    + `line (got ${JSON.stringify(hideAndLearn.measurementVerdict)}), so the next check is not vacuous`);
  check(hideAndLearn.constructionVerdict === 'skipped',
    `the live TD-edit learning funnel must refuse a construction line — otherwise dragging `
    + `a restyled auto line writes the stitch path into that POM's anchor bucket, and the `
    + `learning store outlives the project (got ${JSON.stringify(hideAndLearn.constructionVerdict)})`);

  // ---- 7d. A hidden line that becomes construction must not be stranded ----
  //
  // Hiding is a POM-review gesture. Before the code review, a hidden line
  // restyled to a stitch style kept its id in state.hiddenAnnIds and nothing
  // pruned it: never painted, never exported, no spec row left to carry its ×,
  // and filtered out of the selection set — unreachable, but still counted.
  const strand = await s.eval(`(async () => {
    const { d, settle, deselect, click, pickStitchStyle } = window.__LP;
    d.setHiddenAnnIds([]);
    await settle();
    const line = d.getAnnotations().find(a => a.id === 9601);
    d.setHiddenAnnIds([9601]);
    await settle();
    const hiddenWhileMeasurement = !d.getExportAnnIds().includes(9601);
    // Restyle it through the real path while it is still hidden.
    await deselect();
    await click((line.start.x + line.end.x) / 2, line.start.y);
    const reachedBySelection = d.getMeasurementAnnIds !== undefined;
    d.setPomSpecOverride && null;
    // The spec row for a hidden POM still renders, and clicking it selects the
    // line — the route a TD actually has to a hidden line.
    const row = document.querySelector('#specBody tr[data-ann-id="9601"]');
    if (row) row.click();
    await settle();
    const modeBeforeRestyle = window.__LP.modeTag();
    await pickStitchStyle('cover');
    const after = d.getAnnotations().find(a => a.id === 9601);
    return {
      hiddenWhileMeasurement,
      rowExisted: !!row,
      styleNow: after.style,
      drawnAgain: d.getExportAnnIds().includes(9601),
      modeBeforeRestyle,
      modeAfterRestyle: window.__LP.modeTag(),
    };
  })()`);
  check(strand.hiddenWhileMeasurement === true,
    'precondition: hiding a measurement line does remove it from the export set');
  check(strand.rowExisted === true,
    'precondition: a hidden POM still has a spec row — that row is the only route to it');
  check(strand.styleNow === 'cover',
    `selecting a hidden line through its spec row and picking a stitch style restyles `
    + `THAT line (got ${strand.styleNow})`);
  check(strand.modeBeforeRestyle === 'POM' && strand.modeAfterRestyle === 'POM',
    `...and must not flip the board's mode. A hidden primary used to make the plural `
    + `selection getter return [] while the toolbar still showed the line as selected, so `
    + `the style change fell through to the board-wide default `
    + `(${strand.modeBeforeRestyle} -> ${strand.modeAfterRestyle})`);
  check(strand.drawnAgain === true,
    'a hidden line that becomes construction is DRAWN again — hiding is a POM-review '
    + 'gesture and a construction line is not a POM, so it can no longer be stranded');

  // ---- 8. The library persists, survives corruption, and travels ----------
  const saved = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    d.resetLinePresets();
    const made = d.addLinePreset('Suite preset');
    return { id: made.id, count: d.getLinePresets().length, raw: localStorage.getItem('bra-line-presets-v1') };
  })()`);
  check(saved.count === 6, `a saved preset joins the five built-ins (got ${saved.count})`);
  check(saved.raw && saved.raw.includes('Suite preset'), 'a saved preset is written to localStorage');

  await reloadKeepingErrors(s, ERROR_TRAP);
  const afterReload = await s.eval(`window.__braAutoModeDebug.getLinePresets().map(p => p.name)`);
  check(afterReload.includes('Suite preset'),
    `the library survives a reload (got ${JSON.stringify(afterReload)})`);

  const corrupt = await s.eval(`(async () => {
    localStorage.setItem('bra-line-presets-v1', '{not json at all');
    return true;
  })()`);
  check(corrupt === true, 'precondition: a corrupt payload was stored');
  await reloadKeepingErrors(s, ERROR_TRAP);
  const afterCorrupt = await s.eval(`window.__braAutoModeDebug.getLinePresets().map(p => p.name)`);
  check(afterCorrupt.length === 5,
    `a corrupt library falls back to the built-in set instead of throwing (got ${JSON.stringify(afterCorrupt)})`);

  const roundTrip = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const json = d.exportLinePresetsJson();
    d.resetLinePresets();
    const extra = JSON.stringify({ presets: [{ id: 'lp-shared', name: 'From a colleague', style: 'cover', color: 'black', lineWidth: 3, arrowType: 'none' }] });
    const added = d.importLinePresetsJson(extra);
    const names = d.getLinePresets().map(p => p.name);
    return { added, names, exportedHasBuiltins: json.includes('Zigzag (blue, no arrow)') };
  })()`);
  check(roundTrip.exportedHasBuiltins, 'the JSON export carries the library');
  check(roundTrip.added === 1 && roundTrip.names.includes('From a colleague'),
    `an imported preset MERGES into the library rather than replacing it (got ${JSON.stringify(roundTrip.names)})`);
  check(roundTrip.names.includes('Zigzag (blue, no arrow)'),
    'importing must not drop the presets already there');

  const embed = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const project = d.exportProject();
    const namesBefore = d.getLinePresets().map(p => p.name);
    // A file saved before US-096 has no key at all — it must not clear the
    // local library.
    const withoutKey = { ...project, state: { ...project.state } };
    delete withoutKey.state.linePresets;
    await d.loadProject(withoutKey);
    return { embedded: (project.state.linePresets || []).map(p => p.name), namesBefore,
      namesAfter: d.getLinePresets().map(p => p.name) };
  })()`);
  check(embed.embedded.includes('From a colleague'),
    `the project file carries a copy of the library (got ${JSON.stringify(embed.embedded)})`);
  check(embed.namesAfter.join('|') === embed.namesBefore.join('|'),
    `opening a project must not rewrite the local library (${JSON.stringify(embed.namesBefore)} -> ${JSON.stringify(embed.namesAfter)})`);

  // ---- 8b. "Import from project", driven through its button ---------------
  //
  // The model half above proves a project cannot overwrite the local library.
  // This is the other half: the TD's actual route to the presets the project
  // WAS drawn with, including the row's own visibility rule (it must not offer
  // itself when the file adds nothing new).
  const projectImport = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    // Section 8 reloads the page twice, which wipes window.__LP — everything
    // from here on talks to the debug API directly and settles on a plain timer.
    const settle = () => new Promise(r => setTimeout(r, 140));
    d.resetLinePresets();
    const project = d.exportProject();
    const before = { ...project, state: { ...project.state, linePresets: [
      ...project.state.linePresets,
      { id: 'lp-from-file', name: 'Only in the file', style: 'bartack', color: 'blue', lineWidth: 4, arrowType: 'none' },
    ] } };
    document.getElementById('stitchesBtn').click();
    await settle();
    const rowHiddenBefore = document.getElementById('linePresetImportProjectBtn').hidden;
    document.getElementById('stitchesBtn').click();
    await settle();

    await d.loadProject(before);
    await settle();
    const localAfterLoad = d.getLinePresets().map(p => p.name);
    document.getElementById('stitchesBtn').click();
    await settle();
    const row = document.getElementById('linePresetImportProjectBtn');
    const offered = { hidden: row.hidden, label: row.textContent };
    row.click();
    await settle();
    const afterImport = d.getLinePresets().map(p => p.name);
    document.getElementById('stitchesBtn').click();
    await settle();
    document.getElementById('stitchesBtn').click();
    await settle();
    const rowHiddenAfter = document.getElementById('linePresetImportProjectBtn').hidden;
    return { rowHiddenBefore, localAfterLoad, offered, afterImport, rowHiddenAfter,
      imported: d.getLinePresets().find(p => p.id === 'lp-from-file') };
  })()`);
  check(projectImport.rowHiddenBefore === true,
    'the project-import row stays hidden until a project actually offers something new');
  check(!projectImport.localAfterLoad.includes('Only in the file'),
    `opening the project must NOT silently add its presets to the local library `
    + `(got ${JSON.stringify(projectImport.localAfterLoad)})`);
  check(projectImport.offered.hidden === false && /1 preset from project/.test(projectImport.offered.label),
    `...it offers them instead, and says how many `
    + `(hidden ${projectImport.offered.hidden}, label ${JSON.stringify(projectImport.offered.label)})`);
  check(projectImport.afterImport.includes('Only in the file'),
    `clicking the row imports them (got ${JSON.stringify(projectImport.afterImport)})`);
  check(projectImport.imported && projectImport.imported.style === 'bartack'
    && projectImport.imported.lineWidth === 4,
    'the imported preset keeps its whole look, not just its name');
  check(projectImport.rowHiddenAfter === true,
    'and the row hides again once there is nothing left to import');

  // ---- 8c. The two file paths, end to end --------------------------------
  //
  // Added 2026-08-23 after the story's own validation.md admitted these were
  // untested: the JSON envelope was covered, but the DOWNLOAD that carries it
  // out and the <input type="file"> -> FileReader path that brings one back in
  // were not. Both are the only route a TD has to move presets between
  // machines, and both are pure wiring — exactly where a silent break hides.
  const fileRoundTrip = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const settle = () => new Promise(r => setTimeout(r, 140));
    d.resetLinePresets();
    d.addLinePreset('Travels by file');

    // --- Export: intercept the real download rather than stub the function ---
    const realCreate = URL.createObjectURL;
    let captured = null;
    let filename = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    URL.createObjectURL = function (blob) { captured = blob; return 'blob:captured'; };
    try {
      document.getElementById('stitchesBtn').click();
      await settle();
      document.getElementById('linePresetExportBtn').click();
      await settle();
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }
    const text = captured ? await captured.text() : null;

    // --- Import: drive the real file input with a real File ------------------
    d.resetLinePresets();
    const beforeImport = d.getLinePresets().map(p => p.name);
    const input = document.getElementById('linePresetFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([text || '{}'], 'line-presets.json', { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // FileReader is async; the change handler has no promise to await.
    for (let i = 0; i < 25 && !d.getLinePresets().some(p => p.name === 'Travels by file'); i += 1) {
      await settle();
    }
    return {
      filename,
      blobType: captured && captured.type,
      exported: text,
      beforeImport,
      afterImport: d.getLinePresets().map(p => p.name),
      inputCleared: input.value === '',
    };
  })()`);
  check(fileRoundTrip.filename === 'line-presets.json',
    `Export JSON hands the browser a named file (got ${JSON.stringify(fileRoundTrip.filename)})`);
  check(fileRoundTrip.blobType === 'application/json',
    `...with the right MIME type (got ${JSON.stringify(fileRoundTrip.blobType)})`);
  check(typeof fileRoundTrip.exported === 'string'
    && fileRoundTrip.exported.includes('Travels by file'),
    'the downloaded bytes actually carry the library');
  check(!fileRoundTrip.beforeImport.includes('Travels by file'),
    'precondition: the library was reset, so the import below has something to prove');
  check(fileRoundTrip.afterImport.includes('Travels by file'),
    `choosing that same file in the real <input type="file"> brings the preset back — `
    + `the FileReader path, not just the parser (got ${JSON.stringify(fileRoundTrip.afterImport)})`);
  check(fileRoundTrip.inputCleared === true,
    'the file input is cleared, so picking the same file twice fires change again');

  // ---- 9. Deleting every preset must STICK across a reload -----------------
  //
  // "Stored an empty library" and "never stored one" are different states, and
  // conflating them re-seeds the built-ins on the next load. Same seed-when-
  // empty trap US-074 hit with the BOM reference sheet.
  const emptied = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    d.resetLinePresets();
    const seeded = d.getLinePresets().length;
    // Emptied through the row × buttons, not a model shortcut: a TD can only
    // reach this state one delete at a time, and driving the real control also
    // proves the button reaches the persisting commit path.
    document.getElementById('stitchesBtn').click();
    let guard = 0;
    while (document.querySelector('#linePresetList [data-preset-action="delete"]') && guard++ < 20) {
      document.querySelector('#linePresetList [data-preset-action="delete"]').click();
    }
    return { seeded, remaining: d.getLinePresets().length, guard };
  })()`);
  check(emptied.seeded === 5, `precondition: the built-in set was there to delete (got ${emptied.seeded})`);
  check(emptied.guard < 20, 'the delete loop terminated rather than hitting its guard');
  check(emptied.remaining === 0,
    `deleting every row empties the library in-session (got ${emptied.remaining})`);

  await reloadKeepingErrors(s, ERROR_TRAP);
  const emptyAfterReload = await s.eval(`window.__braAutoModeDebug.getLinePresets().map(p => p.name)`);
  check(emptyAfterReload.length === 0,
    `an emptied library must STAY empty across a reload — re-seeding the built-ins gives a `
    + `TD who works only with house looks no way to make the deletion stick `
    + `(got ${JSON.stringify(emptyAfterReload)})`);

  // ---- 10. A refused write is reported as a refusal, not a save ------------
  //
  // Driven through the REAL Save dialog, not the model. Second code review,
  // 2026-08-23: the first version called addLinePreset() directly and asserted
  // the toast that saveLinePresets fired from inside itself. That was the wrong
  // place for the message — showToast QUEUES rather than replaces, so in the
  // actual UI the panel's own "Saved" landed immediately afterwards and became
  // the TD's last word, and the wording was wrong for the four callers that are
  // not a save. The panel now words one toast per action; only driving the
  // panel can see that.
  const refusedWrite = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const settle = () => new Promise(r => setTimeout(r, 150));
    d.resetLinePresets();
    const original = Storage.prototype.setItem;
    const toasts = [];
    let deleteToast = null;
    Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
    try {
      document.getElementById('stitchesBtn').click();
      await settle();
      document.getElementById('linePresetSaveBtn').click();
      await settle();
      const input = document.querySelector('.picker-overlay input[type="text"]');
      input.value = 'Will not persist';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      // Read the toast AFTER everything the click chain queues has landed.
      await settle(); await settle();
      toasts.push((document.getElementById('toast') || {}).textContent || '');
      // A delete must not claim to be a save.
      document.getElementById('stitchesBtn').click();
      await settle();
      document.querySelector('#linePresetList [data-preset-action="delete"]').click();
      await settle(); await settle();
      deleteToast = (document.getElementById('toast') || {}).textContent || '';
    } finally {
      Storage.prototype.setItem = original;
    }
    return { saveToast: String(toasts[0] || ''), deleteToast: String(deleteToast || ''),
      inMemory: d.getLinePresets().map(p => p.name) };
  })()`);
  check(/session only/i.test(refusedWrite.saveToast),
    `a browser that refuses the write must say so, and that must be the LAST thing the TD `
    + `reads — a "Saved" landing after it means the preset vanishes on the next reload with `
    + `no warning (toast was ${JSON.stringify(refusedWrite.saveToast)})`);
  check(/Saved/i.test(refusedWrite.saveToast),
    '...while still naming what happened, in ONE message rather than two contradicting ones');
  check(/Deleted/i.test(refusedWrite.deleteToast) && !/Saved/i.test(refusedWrite.deleteToast),
    `a refused DELETE must not be reported as a refused save — the message is worded per `
    + `action (got ${JSON.stringify(refusedWrite.deleteToast)})`);

  // ---- 11. The two fixes nothing was watching ------------------------------
  //
  // Both were flagged by the second audit as entirely uncovered, and both are
  // ORDERING/GATING edits whose absence leaves every other assertion green.
  const uncovered = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const settle = () => new Promise(r => setTimeout(r, 140));
    const canvas = document.getElementById('boardCanvas');
    const toClient = (wx, wy) => {
      const v = d.getView();
      const r = canvas.getBoundingClientRect();
      return { x: wx * v.zoom + v.panX + r.left, y: wy * v.zoom + v.panY + r.top };
    };
    const click = async (wx, wy) => {
      const p = toClient(wx, wy);
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: p.x, clientY: p.y, bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: p.x, clientY: p.y, bubbles: true, button: 0 }));
      await settle();
    };

    // Section 8 reloads the page three times, so by here the board is empty and
    // window.__LP is gone. Rebuild the minimum this section needs.
    if (!d.getImages().length) {
      const c = document.createElement('canvas');
      c.width = 600; c.height = 420;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 600, 420);
      await d.addBoardImages([c.toDataURL('image/png')]);
      document.getElementById('modeManualBtn').click();
      await settle();
    }

    // --- Fix 3: deleting a construction line records no ABSENCE evidence ----
    // The guard sits ABOVE markDeletedAutoAnnotationForEvidence. Moving it back
    // below leaves deletedPomKeys protected (so section 3 stays green) while
    // Save Evidence still learns "this style has no POM 16" from a line the TD
    // declared to be construction.
    const img = d.getImages()[0];
    const autoish = {
      id: 9800, seq: 16, type: 'straight', style: 'zigzag', color: 'red',
      arrowType: 'none', lineWidth: 2.5,
      start: { x: img.x + 100, y: img.y + 300 }, end: { x: img.x + 240, y: img.y + 300 },
      control1: null, control2: null, points: [],
      label: { x: img.x + 170, y: img.y + 292 }, labelManual: false,
      text: null, value: null, sourceImageId: img.id,
      auto: true, sourceMode: 'auto-mode', autoRunId: 'suite-run',
    };
    d.styleEvidence.pushAnnotation(autoish);
    await settle();
    const beforeDeleted = (d.getState().deletedAutoCount !== undefined)
      ? d.getState().deletedAutoCount : null;
    document.getElementById('toolSelect').click();
    await settle();
    await click(img.x + 170, img.y + 300);
    const selectedIt = d.getMeasurementAnnIds().indexOf(9800) === -1;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle();
    const goneFromBoard = !d.getAnnotations().some(a => a.id === 9800);
    const absenceCandidates = d.styleEvidence.collectCandidates()
      .filter(c => c && c.pom === '16');

    // --- Fix 12: an unpainted callout keeps no grabbable hitbox -------------
    const mark = {
      id: 9801, seq: 17, type: 'straight', style: 'zigzag', color: 'red',
      arrowType: 'none', lineWidth: 2.5,
      start: { x: img.x + 100, y: img.y + 330 }, end: { x: img.x + 240, y: img.y + 330 },
      control1: null, control2: null, points: [],
      label: { x: img.x + 170, y: img.y + 314 }, labelManual: false,
      text: null, value: null, sourceImageId: img.id,
    };
    d.styleEvidence.pushAnnotation(mark);
    await settle();
    document.getElementById('boardCanvas').dispatchEvent(new MouseEvent('mousedown',
      { clientX: 4, clientY: 4, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 4, clientY: 4, bubbles: true }));
    await settle();
    // Press exactly on the (unpainted) label point. The interaction has to be
    // read while the button is DOWN — every interaction ends on mouseup, so
    // reading it afterwards is null whatever happened, which would make this a
    // tautology. The resulting SELECTION is checked too, because it persists.
    const lp = toClient(mark.label.x, mark.label.y);
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: lp.x, clientY: lp.y, bubbles: true, button: 0 }));
    const grabbedPhantom = d.getInteraction();
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: lp.x, clientY: lp.y, bubbles: true, button: 0 }));
    await settle();
    const selectionAfter = d.getState().selection;

    // Control: the same press ON A PAINTED callout DOES grab it, so "nothing
    // grabbed" above cannot be an artefact of the press missing entirely.
    const painted = {
      id: 9802, seq: 18, type: 'straight', style: 'solid', color: 'red',
      arrowType: 'none', lineWidth: 2.5,
      start: { x: img.x + 100, y: img.y + 360 }, end: { x: img.x + 240, y: img.y + 360 },
      control1: null, control2: null, points: [],
      label: { x: img.x + 170, y: img.y + 344 }, labelManual: false,
      text: null, value: null, sourceImageId: img.id,
    };
    d.styleEvidence.pushAnnotation(painted);
    document.getElementById('toolSelect').click();
    await settle();
    const cp = toClient(painted.label.x, painted.label.y);
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: cp.x, clientY: cp.y, bubbles: true, button: 0 }));
    const grabbedPainted = d.getInteraction();
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: cp.x, clientY: cp.y, bubbles: true, button: 0 }));
    await settle();

    return {
      selectedIt, goneFromBoard,
      absenceCount: absenceCandidates.length,
      absenceStatuses: absenceCandidates.map(c => c.tdStatus),
      phantomInteraction: grabbedPhantom ? String(grabbedPhantom.type || grabbedPhantom) : null,
      phantomSelectedId: selectionAfter && selectionAfter.kind === 'annotation' ? selectionAfter.id : null,
      paintedInteraction: grabbedPainted ? String(grabbedPainted.type || grabbedPainted) : null,
    };
  })()`);
  check(uncovered.goneFromBoard === true,
    'precondition: the auto-flagged construction line was selected and deleted');
  check(uncovered.absenceCount === 0,
    `deleting a construction line must teach learning NOTHING — an "absent-confirmed" record `
    + `here says the style has no POM 16, from a line the TD had already declared to be `
    + `construction (got ${uncovered.absenceCount} candidate(s): ${JSON.stringify(uncovered.absenceStatuses)})`);
  check(uncovered.paintedInteraction !== null,
    `control: pressing on a PAINTED callout does grab it (${JSON.stringify(uncovered.paintedInteraction)}) — `
    + `without this the next check passes whenever the press simply misses`);
  check(uncovered.phantomInteraction !== 'drag-label' && uncovered.phantomSelectedId !== 9801,
    `pressing on a construction line's UNPAINTED callout point must not grab that callout — `
    + `the box is ~22-36 px wide and runs BEFORE the body test, so an ungated one shadows `
    + `whatever real POM line passes beneath it, and startLabelDrag then moves something the `
    + `TD cannot see (interaction ${JSON.stringify(uncovered.phantomInteraction)}, `
    + `selected ${JSON.stringify(uncovered.phantomSelectedId)})`);
  check(uncovered.paintedInteraction === 'drag-label',
    `control detail: the painted callout press is specifically a label drag `
    + `(${JSON.stringify(uncovered.paintedInteraction)}), which is exactly what the phantom `
    + `press must NOT produce — the two assertions are the same gate read both ways`);

  const errors = [...pageErrors, ...(await s.eval(`window.__lpErrors || []`))];
  check(errors.length === 0, `page errors during the run: ${JSON.stringify(errors)}`);

  s.close();
  console.log(`line-presets-check: PASS (${passed} checks)`);
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
