#!/usr/bin/env node
// Boundary characterization (ADR 0103 Phase C) — written BEFORE Phase C.
//
// Phase C re-routes how the board reaches its features: render layers,
// pointer dispatch, the status/toolbar refresh, the initial state and the
// xlsx writer's default grid. It must change none of their OUTPUT. This suite
// records that output on today's code as a golden and fails if any of it
// moves:
//
//   render   every CanvasRenderingContext2D call (method + args, style
//            setters included) of one board render, per scenario; and of the
//            off-screen PDF export page.
//   routing  a grid of pointer probes over the board: what hover resolves to,
//            which gesture a press opens, and what a click selects — plus a
//            proof the probes did not mutate any geometry.
//   chrome   the page DOM after the status/toolbar refresh (toast excluded).
//   state    a fresh app's exported project and state keys.
//   xlsx     the Measurement Spec workbook's sheet XML (docProps excluded).
//
// Scenarios: auto-review (demo1 detected, drafts + anchors + overlay), manual
// (demo1 applied + a Board Graphic, a note, zigzag and cover stitch lines),
// dxf (3380.dxf imported + one Pattern Measure measurement).
//
//   node scripts/boundary-characterization-check.mjs            compare to golden
//   node scripts/boundary-characterization-check.mjs --update   (re)record golden
//   node scripts/boundary-characterization-check.mjs --selftest prove it can see:
//        a labels toggle must change the manual render hash, and a 6px note
//        move must change the manual routing table.
//
// Fixtures: demo/demo1.jpg and demo/DXF file/3380.dxf. Without demo/ (the
// public mirror) the suite SKIPs.
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launchHeadlessApp } from './headless-app.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(appDir, 'scripts', 'boundary-golden.json');
const args = new Set(process.argv.slice(2));
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

// The app stamps TODAY into two of the recorded outputs: MAIN PAGE's "Tech
// Pack Creation date" (ISO — in the page DOM and the exported project) and
// the workbook's date cell (formatSpecDate, "23.Sep.26"). Hashed raw, a golden
// passes only on the day it was recorded. Each run therefore maps the
// browser's own today onto the golden's recording day before hashing.
// --update writes `recordedOn`; the first golden predates the field.
//
// Same for the page's own <script src="app.js?v=…">: build-app.mjs
// content-hashes that cache-buster, so it changes with EVERY code edit —
// exactly what Phase C is — while proving nothing about output. Hashed raw,
// the chrome golden could never pass again after the first src change.
// --update writes `recordedAppBuster`; the first golden's is 6f20a000e59d.
const FIRST_GOLDEN_RECORDED_ON = '2026-09-23';
const FIRST_GOLDEN_APP_BUSTER = '6f20a000e59d';
const SPEC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const specDate = iso => { const [y, m, d] = iso.split('-'); return d + '.' + SPEC_MONTHS[Number(m) - 1] + '.' + y.slice(2); };
const dateMapper = (today, recordedOn) => (!recordedOn || recordedOn === today ? s => s
  : s => s.split(today).join(recordedOn).split(specDate(today)).join(specDate(recordedOn)));
const busterMapper = (buster, recordedBuster) => (!recordedBuster || !buster || recordedBuster === buster ? s => s
  : s => s.split('app.js?v=' + buster + '"').join('app.js?v=' + recordedBuster + '"'));

if (!existsSync(path.join(appDir, 'demo', 'demo1.jpg')) || !existsSync(path.join(appDir, 'demo', 'DXF file', '3380.dxf'))) {
  console.log('SKIP  boundary-characterization-check   demo fixtures absent (public mirror)');
  process.exit(0);
}

// ---------------------------------------------------------------- in-page kit
const KIT = `(() => {
  if (window.__bc) return true;
  const board = document.getElementById('boardCanvas');
  const P = CanvasRenderingContext2D.prototype;
  const bc = window.__bc = { on: false, target: 'board', log: [] };
  const want = ctx => bc.on && (bc.target === 'board' ? ctx.canvas === board : ctx.canvas !== board);
  const fmt = v => {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : String(v);
    if (typeof v === 'string' || typeof v === 'boolean' || v == null) return v;
    if (Array.isArray(v)) return v.map(fmt);
    if (v instanceof HTMLImageElement) return 'img:' + v.naturalWidth + 'x' + v.naturalHeight;
    if (v instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas)) return 'canvas:' + v.width + 'x' + v.height;
    if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) return 'bitmap:' + v.width + 'x' + v.height;
    return 'obj:' + (v && v.constructor ? v.constructor.name : typeof v);
  };
  for (const m of ['save','restore','scale','rotate','translate','transform','setTransform','resetTransform','beginPath','closePath',
    'moveTo','lineTo','bezierCurveTo','quadraticCurveTo','arc','arcTo','ellipse','rect','roundRect','fill','stroke','clip',
    'fillRect','strokeRect','clearRect','fillText','strokeText','drawImage','setLineDash','putImageData']) {
    const orig = P[m]; if (typeof orig !== 'function') continue;
    P[m] = function (...a) { if (want(this)) bc.log.push([m, ...a.map(fmt)]); return orig.apply(this, a); };
  }
  for (const k of ['fillStyle','strokeStyle','lineWidth','lineCap','lineJoin','font','textAlign','textBaseline','globalAlpha',
    'globalCompositeOperation','shadowBlur','shadowColor','shadowOffsetX','shadowOffsetY','lineDashOffset','miterLimit','filter','imageSmoothingEnabled']) {
    const d = Object.getOwnPropertyDescriptor(P, k); if (!d || !d.set) continue;
    Object.defineProperty(P, k, { configurable: true, get: d.get, set(v) { if (want(this)) bc.log.push(['=' + k, fmt(v)]); d.set.call(this, v); } });
  }
  const raf = () => new Promise(r => requestAnimationFrame(() => r()));
  bc.frame = async () => { await raf(); await raf(); };
  // One board render, traced. setView() with the current view is the app's own
  // requestRender() path; nothing else is scheduled while we wait.
  bc.traceRender = async () => {
    const d = window.__braAutoModeDebug;
    await bc.frame();
    bc.log = []; bc.target = 'board'; bc.on = true;
    d.setView(d.getView());
    await bc.frame();
    bc.on = false;
    return bc.log.splice(0);
  };
  bc.tracePdf = async () => {
    const d = window.__braAutoModeDebug;
    const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    const url = URL.createObjectURL; URL.createObjectURL = () => 'blob:bc';
    await bc.frame();
    bc.log = []; bc.target = 'export'; bc.on = true;
    const ran = d.commands.run('board.export.pdf');
    bc.on = false;
    HTMLAnchorElement.prototype.click = click; URL.createObjectURL = url;
    await bc.frame();
    return { ran, log: bc.log.splice(0) };
  };
  bc.chrome = () => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('#toast, .toast').forEach(e => e.remove());
    return clone.outerHTML;
  };
  bc.geometry = () => JSON.stringify({
    anns: window.__braAutoModeDebug.getAnnotations().map(a => [a.id, a.start, a.end, a.control1, a.control2, a.points, a.label]),
    notes: window.__braAutoModeDebug.getNotes().map(n => [n.id, n.pos, n.leaders]),
    graphics: window.__braAutoModeDebug.getGraphics(),
  });
  // Pointer probes on a COLS x ROWS grid inside the canvas: hover, press, release.
  bc.routing = async (cols, rows) => {
    const d = window.__braAutoModeDebug;
    const r = board.getBoundingClientRect();
    const ev = (type, x, y, init) => (type === 'mouseup' ? window : board).dispatchEvent(new MouseEvent(type, Object.assign({ clientX: x, clientY: y, bubbles: true, cancelable: true }, init)));
    const before = bc.geometry();
    const out = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = r.left + r.width * (i + 0.5) / cols, y = r.top + r.height * (j + 0.5) / rows;
      ev('mousemove', x, y, { buttons: 0 });
      const s1 = d.getState();
      ev('mousedown', x, y, { button: 0, buttons: 1 });
      const it = d.getInteraction();
      ev('mouseup', x, y, { button: 0, buttons: 0 });
      const s2 = d.getState();
      out.push([i, j, s1.hoverAnnotationId, board.style.cursor || '', it ? [it.type, it.part, it.id] : null,
        [s2.selection.kind, s2.selection.id, s2.selection.part], s2.selectedAnnotationIds.length]);
    }
    await bc.frame();
    return { table: out, geometryUnchanged: before === bc.geometry() };
  };
  return true;
})()`;

async function scenarioSetup(s, name, perturb) {
  if (name === 'auto-review') {
    await s.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      const b = await (await fetch('/demo/demo1.jpg', { cache: 'no-store' })).blob();
      const u = await new Promise(r => { const f = new FileReader(); f.onload = () => r(String(f.result)); f.readAsDataURL(b); });
      await d.runAutoOnDataUrl(u);
      await window.__bc.frame();
    })()`);
  } else if (name === 'manual') {
    await s.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      d.approveDrawableDrafts(); d.applyApprovedDrafts();
      await window.__bc.frame();
      const img = d.getImages()[0];
      const at = (fx, fy) => ({ x: img.x + img.width * fx, y: img.y + img.height * fy });
      d.graphics.addLive('rect', { x: img.x + img.width * 0.05, y: img.y + img.height * 0.05, width: img.width * 0.18, height: img.height * 0.12 }, img.id);
      d.addNote('Check band seam', at(0.72, 0.08));
      d.seamPath.addTestAnnotation({ type: 'straight', style: 'zigzag', color: 'blue', start: at(0.2, 0.9), end: at(0.8, 0.9) });
      d.seamPath.addTestAnnotation({ type: 'curved', style: 'cover', color: 'green', start: at(0.2, 0.8), end: at(0.8, 0.8), control1: at(0.35, 0.72), control2: at(0.65, 0.72) });
      await window.__bc.frame();
    })()`);
    if (perturb === 'labels') await s.eval(`(async () => { document.getElementById('toggleLabelsBtn').click(); await window.__bc.frame(); })()`);
    if (perturb === 'note') await s.eval(`(async () => {
      const d = window.__braAutoModeDebug; const n = d.getNotes()[0];
      const p = d.exportProject(); const pn = p.state.notes.find(x => x.id === n.id); pn.pos = { x: pn.pos.x + 6, y: pn.pos.y };
      await d.loadProject(p); document.getElementById('modeManualBtn').click(); await window.__bc.frame();
    })()`);
  } else if (name === 'dxf') {
    await s.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      const p = d.exportProject(); p.state.annotations = []; p.state.images = []; p.state.notes = []; p.state.graphics = [];
      await d.loadProject(p);
      document.getElementById('modeManualBtn').click();
      const text = await (await fetch('/demo/DXF%20file/3380.dxf', { cache: 'no-store' })).text();
      const input = document.getElementById('projectFileInput');
      const dt = new DataTransfer(); dt.items.add(new File([text], '3380.dxf', { type: 'application/octet-stream' }));
      input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 200 && d.getAnnotations().length < 10; i++) await new Promise(r => setTimeout(r, 50));
      await window.__bc.frame();
      // One Pattern Measure measurement: out-of-path, endpoint to endpoint on piece 0.
      const segs = d.dxf.measure.pieceSegments(0) || [];
      const a = segs[0] && (segs[0].a || segs[0].p0), b = segs[Math.floor(segs.length / 2)] && (segs[Math.floor(segs.length / 2)].a || segs[Math.floor(segs.length / 2)].p0);
      if (a && b) {
        d.commands.run('board.pattern-measure.out-of-path');
        const board = document.getElementById('boardCanvas');
        const v = d.getView(), r = board.getBoundingClientRect();
        const click = (pt) => { const w = d.dxf.measure.nativeToBoardLive(pt, 0) || d.dxf.measure.nativeToBoard(pt); const x = w.x * v.zoom + v.panX + r.left, y = w.y * v.zoom + v.panY + r.top;
          board.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }));
          window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0, buttons: 0, bubbles: true })); };
        click(a); await window.__bc.frame(); click(b); await window.__bc.frame();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      await window.__bc.frame();
    })()`);
  }
}

function summarizeTrace(log) {
  const counts = {};
  for (const e of log) counts[e[0]] = (counts[e[0]] || 0) + 1;
  return { hash: sha(JSON.stringify(log)), calls: log.length, counts };
}

async function unzipSheets(base64, undate) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bc-xlsx-'));
  const file = path.join(dir, 'spec.xlsx');
  writeFileSync(file, Buffer.from(base64, 'base64'));
  const list = execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter(n => /^xl\/.*\.xml$/.test(n) && !/docProps/.test(n)).sort();
  const parts = {};
  for (const n of list) parts[n] = sha(undate(execFileSync('unzip', ['-p', file, n]).toString('utf8')));
  return parts;
}

async function record(perturb, recordedOn, recordedAppBuster) {
  const app = await launchHeadlessApp({ appDir, query: 'smoke', windowSize: '1400,900', readyTimeout: 20000, profilePrefix: 'boundary-bc-' });
  const out = { scenarios: {} };
  const raw = {};
  let today = null;
  let appBuster = null;
  try {
    const s = app.session;
    await s.waitFor(`(() => { const c = document.getElementById('visionEngineChip'); return !c || /ready/i.test(c.textContent); })()`, 60000).catch(() => {});
    await s.eval(KIT);
    today = await s.eval(`(() => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })()`);
    const undate = dateMapper(today, recordedOn);
    appBuster = await s.eval(`(() => { const t = document.querySelector('script[src^="app.js?v="]'); return t ? t.getAttribute('src').slice('app.js?v='.length) : null; })()`);
    const unbust = busterMapper(appBuster, recordedAppBuster);
    // state: a fresh app, before anything is loaded
    const fresh = await s.eval(`(() => { const d = window.__braAutoModeDebug; return { project: JSON.stringify(d.exportProject()), stateKeys: Object.keys(d.getState()).sort() }; })()`);
    const proj = JSON.parse(fresh.project);
    // Volatile by design, masked precisely: timestamps, and the random ids the
    // Line Treatment library mints when it seeds (tl-xxxxxxxx) — renumbered in
    // order of appearance so their count and placement are still compared.
    const tlIds = new Map();
    const scrub = o => { if (o && typeof o === 'object') for (const k of Object.keys(o)) {
      if (/^(savedAt|exportedAt|createdAt|updatedAt)$/.test(k)) o[k] = '<time>';
      else if (typeof o[k] === 'string' && /^tl-[a-z0-9]{8}$/.test(o[k])) { if (!tlIds.has(o[k])) tlIds.set(o[k], 'tl-<' + tlIds.size + '>'); o[k] = tlIds.get(o[k]); }
      else scrub(o[k]); } return o; };
    const scrubbed = scrub(proj);
    out.state = { projectHash: sha(undate(JSON.stringify(scrubbed))), topKeys: Object.keys(proj).sort(), stateKeys: fresh.stateKeys };
    raw.freshProject = undate(JSON.stringify(scrubbed, null, 1));

    for (const name of ['auto-review', 'manual', 'dxf']) {
      await scenarioSetup(s, name, name === 'manual' ? perturb : null);
      const sc = {};
      const trace = await s.eval(`window.__bc.traceRender()`);
      sc.render = summarizeTrace(trace); raw[name + '.render'] = trace;
      // The Auto status shows a per-run id ("Run: auto-<rand>-<rand>"); mask it.
      const chrome = unbust(undate((await s.eval(`window.__bc.chrome()`)).replace(/Run: auto-[a-z0-9]+-[a-z0-9]+/g, 'Run: auto-<id>')));
      sc.chrome = sha(chrome); raw[name + '.chrome.html'] = chrome;
      const routing = await s.eval(`window.__bc.routing(20, 12)`);
      sc.routing = { hash: sha(JSON.stringify(routing.table)), geometryUnchanged: routing.geometryUnchanged,
        kinds: routing.table.reduce((m, r) => { const k = (r[4] ? r[4][0] : 'none') + '/' + r[5][0]; m[k] = (m[k] || 0) + 1; return m; }, {}) };
      raw[name + '.routing'] = routing.table;
      if (name === 'manual') {
        const pdf = await s.eval(`window.__bc.tracePdf()`);
        sc.pdf = { ran: pdf.ran, ...summarizeTrace(pdf.log) }; raw['manual.pdf'] = pdf.log;
        const x = await s.eval(`(async () => { const r = await window.__braAutoModeDebug.exportSpecXlsxBase64(); return typeof r === 'string' ? r : (r && (r.base64 || r.data)); })()`);
        sc.xlsx = x ? await unzipSheets(x, undate) : null;
      }
      if (name === 'dxf') {
        sc.dxfMeasurements = await s.eval(`(() => { const ss = window.__braAutoModeDebug.dxf.measure.getSession(); return ss && ss.measurements ? ss.measurements.length : null; })()`);
      }
      out.scenarios[name] = sc;
    }
  } finally { await app.close(); }
  return { out, raw, today, appBuster };
}

function diffGolden(a, b, where = '', acc = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return acc;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffGolden(a[k], b[k], where ? where + '.' + k : k, acc);
  } else acc.push(`${where}: ${JSON.stringify(a)?.slice(0, 120)} -> ${JSON.stringify(b)?.slice(0, 120)}`);
  return acc;
}

function dumpRaw(raw) {
  const dir = mkdtempSync(path.join(tmpdir(), 'boundary-bc-raw-'));
  for (const [k, v] of Object.entries(raw)) writeFileSync(path.join(dir, k.replace(/[^\w.-]/g, '_') + (typeof v === 'string' ? '' : '.json')), typeof v === 'string' ? v : JSON.stringify(v, null, 0).replace(/\],\[/g, '],\n['));
  return dir;
}

const t0 = Date.now();
if (args.has('--selftest')) {
  if (!existsSync(GOLDEN)) { console.error('No golden yet: run with --update first'); process.exit(1); }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const recordedOn = golden.recordedOn || FIRST_GOLDEN_RECORDED_ON;
  const recordedAppBuster = golden.recordedAppBuster || FIRST_GOLDEN_APP_BUSTER;
  const a = (await record('labels', recordedOn, recordedAppBuster)).out, b = (await record('note', recordedOn, recordedAppBuster)).out;
  const labelsSeen = a.scenarios.manual.render.hash !== golden.scenarios.manual.render.hash;
  const noteSeen = b.scenarios.manual.routing.hash !== golden.scenarios.manual.routing.hash;
  const autoStable = a.scenarios['auto-review'].render.hash === golden.scenarios['auto-review'].render.hash;
  const ok = labelsSeen && noteSeen && autoStable;
  console.log(`${ok ? 'PASS' : 'FAIL'}  boundary-characterization-check --selftest   labels toggle changes manual render: ${labelsSeen}; 6px note move changes manual routing: ${noteSeen}; untouched auto-review render unchanged: ${autoStable}`);
  process.exit(ok ? 0 : 1);
}

if (args.has('--update')) {
  const { out, today, appBuster } = await record(null, null, null);
  writeFileSync(GOLDEN, JSON.stringify({ note: 'Generated by scripts/boundary-characterization-check.mjs --update on the pre-Phase-C code (ADR 0103). Phase C must keep every value here identical.', recordedOn: today, recordedAppBuster: appBuster, ...out }, null, 2) + '\n');
  const s = out.scenarios;
  console.log(`boundary golden written in ${((Date.now() - t0) / 1000).toFixed(0)}s: render calls auto ${s['auto-review'].render.calls} / manual ${s.manual.render.calls} / dxf ${s.dxf.render.calls}, pdf ${s.manual.pdf.calls}, routing probes 3x240, xlsx parts ${Object.keys(s.manual.xlsx || {}).length}, dxf measurements ${s.dxf.dxfMeasurements}`);
  process.exit(0);
}
if (!existsSync(GOLDEN)) { console.error('No golden: run node scripts/boundary-characterization-check.mjs --update'); process.exit(1); }
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const recordedOn = golden.recordedOn || FIRST_GOLDEN_RECORDED_ON;
const recordedAppBuster = golden.recordedAppBuster || FIRST_GOLDEN_APP_BUSTER;
delete golden.note;
delete golden.recordedOn;
delete golden.recordedAppBuster;
const { out, raw } = await record(null, recordedOn, recordedAppBuster);
const diffs = diffGolden(golden, out);
const mutated = Object.entries(out.scenarios).filter(([, v]) => !v.routing.geometryUnchanged).map(([k]) => k);
if (diffs.length || mutated.length) {
  console.log(`FAIL  boundary-characterization-check   ${diffs.length} value(s) differ from the pre-Phase-C golden${mutated.length ? '; routing probes mutated geometry in ' + mutated.join(', ') : ''}:`);
  for (const d of diffs.slice(0, 30)) console.log('  ' + d);
  console.log('  raw traces/tables/HTML of this run: ' + dumpRaw(raw));
  process.exit(1);
}
const s = out.scenarios;
console.log(`PASS  boundary-characterization-check   render (auto ${s['auto-review'].render.calls}, manual ${s.manual.render.calls}, dxf ${s.dxf.render.calls}, pdf ${s.manual.pdf.calls} calls), routing 3x240 probes, chrome x3, fresh state, xlsx ${Object.keys(s.manual.xlsx || {}).length} parts — all identical to golden (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
