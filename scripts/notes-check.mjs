#!/usr/bin/env node
// US-092: Board text notes.
//
// Assertions are made against PIXELS on the real #boardCanvas, not against
// state. "state.notes has one entry" would pass with the renderer deleted, and
// the whole value of a note is that a human can read it on the sketch and in
// the tech pack — so every claim here is "these pixels are this colour in this
// place", measured before and after the note exists.
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

const NOTE_RED = [230, 57, 57];   // LINE_COLORS.red  #e63939
const NOTE_BLUE = [37, 99, 235];  // LINE_COLORS.blue #2563eb

let server, chrome, userDataDir;
const cleanupTasks = [];
let passed = 0;

// World -> canvas buffer pixel sampling. The app's own world->screen transform
// is (world * zoom + pan) in canvas-local CSS pixels; getImageData wants buffer
// pixels, so the dpr the canvas was sized at has to be folded back in. Reading
// it off the live canvas rather than assuming 1 keeps the suite honest on a
// HiDPI runner.
const HARNESS = String.raw`
window.__NC = (() => {
  const d = window.__braAutoModeDebug;
  const canvas = document.getElementById('boardCanvas');
  const settle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40))));
  const sample = (worldRect) => {
    const v = d.getView();
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const x = Math.round((worldRect.x * v.zoom + v.panX) * dpr);
    const y = Math.round((worldRect.y * v.zoom + v.panY) * dpr);
    const w = Math.max(1, Math.round(worldRect.width * v.zoom * dpr));
    const h = Math.max(1, Math.round(worldRect.height * v.zoom * dpr));
    if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) {
      return { offscreen: true, x, y, w, h, buffer: [canvas.width, canvas.height] };
    }
    const data = canvas.getContext('2d').getImageData(x, y, w, h).data;
    return { offscreen: false, x, y, w, h, data: Array.from(data) };
  };
  // How many pixels in the region are within tol of the target colour, and
  // where they sit — the bounding box is what proves a two-line note is taller
  // than a one-line one without exposing internal geometry to the test.
  const countColor = (worldRect, rgb, tol) => {
    const s = sample(worldRect);
    if (s.offscreen) return { offscreen: true, count: 0 };
    let count = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < s.data.length; i += 4) {
      if (Math.abs(s.data[i] - rgb[0]) <= tol
        && Math.abs(s.data[i + 1] - rgb[1]) <= tol
        && Math.abs(s.data[i + 2] - rgb[2]) <= tol
        && s.data[i + 3] > 200) {
        const p = (i / 4) | 0;
        const px = p % s.w, py = (p / s.w) | 0;
        count += 1;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
    return { offscreen: false, count, width: count ? maxX - minX + 1 : 0, height: count ? maxY - minY + 1 : 0 };
  };
  // Mean channel values, INCLUDING alpha. Alpha is not decoration here: the
  // board is cleared to transparent, so an unpainted pixel reads (0,0,0,0) and
  // is indistinguishable from black by rgb alone. A "the backdrop is dark"
  // precondition without it passes when the fixture photo never drew at all.
  const meanColor = (worldRect) => {
    const s = sample(worldRect);
    if (s.offscreen) return { offscreen: true };
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let i = 0; i < s.data.length; i += 4) {
      r += s.data[i]; g += s.data[i + 1]; b += s.data[i + 2]; a += s.data[i + 3]; n += 1;
    }
    return { offscreen: false, r: r / n, g: g / n, b: b / n, a: a / n, n };
  };
  // Colour-agnostic legibility: the spread of luminance inside the note's own
  // box. Text you can read means glyphs that differ from the ground they sit on,
  // whatever colour either happens to be — so this catches white-on-white and
  // black-on-black alike, where counting one specific colour cannot.
  const contrast = (worldRect) => {
    const s = sample(worldRect);
    if (s.offscreen) return { offscreen: true };
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < s.data.length; i += 4) {
      if (s.data[i + 3] < 200) continue; // unpainted board, not part of the note
      const lum = 0.2126 * s.data[i] + 0.7152 * s.data[i + 1] + 0.0722 * s.data[i + 2];
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    if (max < min) return { offscreen: false, spread: 0, min: 0, max: 0 };
    return { offscreen: false, spread: max - min, min, max };
  };
  // Bounding box of the note's painted GROUND — the chip itself, not its ink.
  // noteBounds' height is what this measures; glyph-ink extent is not, which is
  // how a collapsed box could otherwise go unnoticed.
  const groundBox = (worldRect, dark) => {
    const s = sample(worldRect);
    if (s.offscreen) return { offscreen: true, width: 0, height: 0, count: 0 };
    let count = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < s.data.length; i += 4) {
      const lum = 0.2126 * s.data[i] + 0.7152 * s.data[i + 1] + 0.0722 * s.data[i + 2];
      const isGround = s.data[i + 3] > 200 && (dark ? lum < 60 : lum > 195);
      if (!isGround) continue;
      const p = (i / 4) | 0;
      const px = p % s.w, py = (p / s.w) | 0;
      count += 1;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    return {
      offscreen: false, count,
      width: count ? maxX - minX + 1 : 0,
      height: count ? maxY - minY + 1 : 0,
    };
  };
  // ---- Real pointer input (step 5) ---------------------------------------
  // Every gesture below is a genuine MouseEvent on #boardCanvas at a computed
  // client point, never a call into an internal handler: the press CHAIN is the
  // thing under test — which of note / line endpoint / photo claims a click —
  // and calling the winner directly would assert nothing about who wins.
  // mouseup goes to window, matching where the app binds it.
  const toClient = (wx, wy) => {
    const v = d.getView();
    const rect = canvas.getBoundingClientRect();
    return { x: wx * v.zoom + v.panX + rect.left, y: wy * v.zoom + v.panY + rect.top };
  };
  const mouse = (type, wx, wy, target) => {
    const p = toClient(wx, wy);
    (target || canvas).dispatchEvent(new MouseEvent(type, {
      clientX: p.x, clientY: p.y, bubbles: true, button: 0,
    }));
  };
  const down = (wx, wy) => mouse('mousedown', wx, wy);
  const move = (wx, wy) => mouse('mousemove', wx, wy);
  const up = (wx, wy) => mouse('mouseup', wx, wy, window);
  const click = async (wx, wy) => { down(wx, wy); up(wx, wy); await settle(); };
  const dblclick = async (wx, wy) => { mouse('dblclick', wx, wy); await settle(); };
  // Past the 3px arming grace in one hop would skip the arming frame, so the
  // drag is stepped exactly as a hand produces it.
  const drag = async (fromX, fromY, toX, toY) => {
    down(fromX, fromY);
    move(fromX + 1, fromY + 1);
    move((fromX + toX) / 2, (fromY + toY) / 2);
    move(toX, toY);
    const seen = d.getInteraction();
    up(toX, toY);
    await settle();
    return seen;
  };
  const typeInto = (el, text) => {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const commitEditor = async () => {
    document.getElementById('noteEditor')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await settle();
  };
  const key = async (k) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await settle();
  };
  const solidImage = (cssColor, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = cssColor;
    g.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  };
  return { d, settle, sample, countColor, meanColor, contrast, groundBox, solidImage,
    toClient, down, move, up, click, dblclick, drag, typeInto, commitEditor, key };
})();
'ready'`;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'notes-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    // A recognized test query param: without one a view-role prompt can block
    // the run and the harness hangs instead of failing.
    `${started.baseUrl}/index.html?contract=notes${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`!!window.__braAutoModeDebug`, 20000);

  // Refuse to run against a stale bundle: every assertion below is about code
  // that only exists after US-092, and a served-but-old app.js would report it
  // as broken and send the next reader hunting a phantom.
  const served = await s.eval(`(async () => {
    const src = document.querySelector('script[src*="app.js"]').getAttribute('src');
    const txt = await (await fetch(src)).text();
    return {
      src,
      drawNote: txt.includes('function drawNote'),
      noteBounds: txt.includes('function noteBounds'),
      getNotes: typeof window.__braAutoModeDebug.getNotes === 'function',
      addNote: typeof window.__braAutoModeDebug.addNote === 'function',
      hitTestNotes: txt.includes('function hitTestNotes'),
      leaderHandles: txt.includes('function hitTestSelectedNoteHandles'),
      leaderAdd: txt.includes('function noteLeaderAddHandle'),
      noteResize: txt.includes('function noteResizeHandle') && txt.includes("'drag-note-resize'"),
      noteAppearance: typeof window.__braAutoModeDebug.setNoteAppearance === 'function',
      noteColors: typeof window.__braAutoModeDebug.setNoteTextColor === 'function'
        && typeof window.__braAutoModeDebug.setNoteLeaderColor === 'function',
      noteStyleMenu: !!document.getElementById('noteStyleMenuBtn'),
      getNoteHandles: typeof window.__braAutoModeDebug.getNoteHandles === 'function',
      dragNote: txt.includes("'drag-note'"),
      noteEditor: txt.includes('function openNoteEditorForNewNote'),
      getNoteEditor: typeof window.__braAutoModeDebug.getNoteEditor === 'function',
    };
  })()`);
  for (const key of ['drawNote', 'noteBounds', 'getNotes', 'addNote',
    'hitTestNotes', 'dragNote', 'noteEditor', 'getNoteEditor',
    'leaderHandles', 'leaderAdd', 'noteResize', 'noteAppearance', 'noteColors',
    'noteStyleMenu', 'getNoteHandles']) {
    check(served[key] === true,
      `the served bundle (${served.src}) predates US-092 — no ${key}. Run npm run build.`);
  }

  const ready = await s.eval(HARNESS);
  check(ready === 'ready', 'harness did not install');

  // ---- Setup: a black sketch in Manual Mode -------------------------------
  // Black on purpose. A note has to stay readable ON the ink, so "the note
  // paints a light ground" is only testable against a dark backdrop.
  const setup = await s.eval(`(async () => {
    const { d, settle, solidImage } = window.__NC;
    await d.addBoardImages([solidImage('#000000', 600, 400)]);
    document.getElementById('modeManualBtn').click();
    await settle();
    const img = d.getImages()[0];
    return { img, mode: d.getState ? null : null, notes: d.getNotes().length };
  })()`);
  check(!!setup.img, 'the fixture image was not added to the board');
  check(setup.notes === 0, 'the board did not start with an empty note list');

  // ---- 1. A note paints where it was put ---------------------------------
  const render = await s.eval(`(async () => {
    const { d, settle, countColor, meanColor } = window.__NC;
    const img = d.getImages()[0];
    // Inside the black photo, clear of its edges.
    const pos = { x: img.x + img.width * 0.12, y: img.y + img.height * 0.20 };
    const region = { x: pos.x - 4, y: pos.y - 4, width: 180, height: 70 };
    // The ground sample sits in the note's LEFT PADDING COLUMN — inside the box
    // (so it reads the white ground), clear of the border stroke, and clear of
    // the glyphs. Sampling the whole 180x70 region instead would average mostly
    // untouched backdrop and prove nothing: a note box is far smaller than the
    // area a reader would call "around the note".
    const ground = { x: pos.x + 1.2, y: pos.y + 8, width: 3, height: 6 };
    const before = { red: countColor(region, [230,57,57], 26), mean: meanColor(ground) };
    const note = d.addNote('Bartack here', pos, { color: 'red', fontSize: 14, boxWidth: 150 });
    await settle();
    const after = { red: countColor(region, [230,57,57], 26), mean: meanColor(ground) };
    return { note, before, after, region, ground, zoom: d.getView().zoom };
  })()`);
  check(render.before.red.offscreen === false && render.after.red.offscreen === false,
    'the sampled region fell outside the canvas — nothing was measured');
  check(render.before.red.count === 0,
    `the region was not clean before the note: ${render.before.red.count} red px already there`);
  check(render.after.red.count > 40,
    `the note did not paint: only ${render.after.red.count} red px where its text should be`);
  check(render.before.mean.a > 200,
    `the fixture photo never painted there (mean alpha ${render.before.mean.a.toFixed(0)}) — an unpainted board reads (0,0,0,0) and would pass the "dark backdrop" check below without any ink to cover`);
  check(render.before.mean.r < 40 && render.before.mean.g < 40 && render.before.mean.b < 40,
    `the backdrop was not dark (mean rgb ${render.before.mean.r.toFixed(0)},${render.before.mean.g.toFixed(0)},${render.before.mean.b.toFixed(0)}) — the ground test below would be meaningless`);
  check(render.after.mean.r > 180 && render.after.mean.g > 180 && render.after.mean.b > 180,
    `the note did not paint a light ground over the ink: mean rgb ${render.after.mean.r.toFixed(0)},${render.after.mean.g.toFixed(0)},${render.after.mean.b.toFixed(0)}`);
  console.log(`notes-check: note paints ${render.after.red.count} red px on a ground that lifted its interior from ${render.before.mean.r.toFixed(0)} to ${render.after.mean.r.toFixed(0)} (zoom ${render.zoom.toFixed(2)})`);

  // ---- 2. A leader draws an ARROW, not just a line ------------------------
  // "Blue pixels reach the tip" is not enough and was the first version of this
  // check: it passed with drawArrowhead deleted, because the bare leader line
  // already lands on the tip. What distinguishes an arrow is that the ink FANS
  // OUT near the tip, so this measures the ink's thickness across the leader
  // just behind the tip and compares it against the same leader's thickness
  // further back. Self-calibrating — no pixel constants, and it survives any
  // change to the line width or the arrow size.
  const leader = await s.eval(`(async () => {
    const { d, settle, countColor } = window.__NC;
    const img = d.getImages()[0];
    const pos = { x: img.x + img.width * 0.10, y: img.y + img.height * 0.62 };
    // Straight to the right, so "across the leader" is simply "vertically".
    const tip = { x: pos.x + 230, y: pos.y + 12 };
    const strip = (backBy) => ({ x: tip.x - backBy, y: tip.y - 14, width: 1.4, height: 28 });
    const before = countColor(strip(4), [37,99,235], 26);
    const note = d.addNote('Elastic 12mm', pos,
      { color: 'blue', fontSize: 14, boxWidth: 150, leaders: [tip] });
    await settle();
    return {
      before,
      atArrow: countColor(strip(4), [37,99,235], 26),   // inside the arrowhead
      atShaft: countColor(strip(70), [37,99,235], 26),  // bare line, same leader
      noteId: note.id,
    };
  })()`);
  check(leader.before.count === 0,
    `the leader path was not clean before: ${leader.before.count} blue px`);
  check(leader.atShaft.count > 0 && leader.atShaft.height > 0,
    'the leader line itself did not draw — the arrow comparison below would be meaningless');
  check(leader.atArrow.height >= leader.atShaft.height * 2,
    `the leader ends in a line, not an arrow: ink is ${leader.atArrow.height}px across just behind the tip vs ${leader.atShaft.height}px along the shaft`);
  console.log(`notes-check: leader fans out into an arrowhead (${leader.atShaft.height}px shaft -> ${leader.atArrow.height}px at the tip)`);

  // ---- 3. Lines stack: the BOX grows, not just the ink -------------------
  // Measured on the note's painted ground, not on its glyph ink. drawNoteText
  // positions each line from box.y + pad + index * lineHeight and never reads
  // box.height, so glyph-ink extent would look correct even if noteBounds
  // collapsed the box to one line — and the box is what a leader attaches to
  // and what step 5 will hit-test.
  // All three fixtures occupy the SAME clear spot, one at a time, each undone
  // before the next. The first draft laid them out side by side and a neighbour's
  // ground bled into the sampled region — the wrapped box measured 192px against
  // a 185px limit and looked like a real overflow. Isolating them removes the
  // ambiguity instead of widening the tolerance until it passes.
  const wrap = await s.eval(`(async () => {
    const { d, settle, groundBox } = window.__NC;
    const img = d.getImages()[0];
    const at = { x: img.x + img.width * 0.45, y: img.y + img.height * 0.05 };
    const region = { x: at.x - 4, y: at.y - 4, width: 140, height: 110 };
    const drop = async () => {
      document.getElementById('undoBtn').click();
      await settle();
      await new Promise(r => setTimeout(r, 90));
    };
    const measure = async (text, opts) => {
      d.addNote(text, at, opts);
      await settle();
      const box = groundBox(region, false);
      await drop();
      return box;
    };
    const before = d.getNotes().length;
    const one = await measure('SIZE 75B', { color: 'red', fontSize: 13, boxWidth: 180 });
    const two = await measure('SIZE 75B\\nSIZE 75B', { color: 'red', fontSize: 13, boxWidth: 180 });
    // Real word wrap: one long unbroken sentence, no newline, narrow box. This
    // is the only fixture that reaches the greedy-wrap branch at all.
    const small = { color: 'red', fontSize: 10, boxWidth: 90 };
    const oneSmall = await measure('elastic', small);
    const wrapped = await measure('elastic binding must be stitched flat all around the underarm', small);
    return { one, two, oneSmall, wrapped, zoom: d.getView().zoom, clean: d.getNotes().length === before };
  })()`);
  check(wrap.clean === true, 'the wrap fixtures were not undone — later sections would measure them');
  check(wrap.one.count > 100 && wrap.two.count > 100, 'one of the stacking fixtures did not paint a ground');
  check(wrap.two.height > wrap.one.height * 1.5,
    `a newline did not add a line to the BOX: 1-line box is ${wrap.one.height}px tall, 2-line is ${wrap.two.height}px`);
  check(Math.abs(wrap.two.width - wrap.one.width) <= 3,
    `the second line changed the box width (${wrap.one.width} -> ${wrap.two.width}) — text should stack, not stretch`);
  check(wrap.wrapped.offscreen !== true,
    `the wrapped-note sample fell outside the canvas: ${JSON.stringify(wrap.wrapped)}`);
  // Compared against a one-line box at the SAME font size, not against the
  // 13px fixture above — box height is font-size-dependent, so that comparison
  // would be apples to oranges. Above 2x a one-liner means 3 or more lines.
  check(wrap.wrapped.height > wrap.oneSmall.height * 2,
    `a long sentence did not wrap to 3+ lines: its box is ${wrap.wrapped.height}px tall vs ${wrap.oneSmall.height}px for one line at the same size (${JSON.stringify(wrap.wrapped)})`);
  check(wrap.wrapped.width <= Math.round(90 * wrap.zoom) + 4,
    `the wrapped note overflowed its boxWidth: ${wrap.wrapped.width}px painted vs a 90 world-px (${Math.round(90 * wrap.zoom)}px) limit`);
  console.log(`notes-check: boxes stack (${wrap.one.height}px -> ${wrap.two.height}px) and a long sentence wraps ${wrap.oneSmall.height}px -> ${wrap.wrapped.height}px tall, held inside its ${wrap.wrapped.width}px width`);

  // ---- 3b. Every palette colour produces READABLE text -------------------
  // Counting one known colour cannot see a note whose ink matches its own
  // ground: white text on the white ground rendered a blank chip — 0 non-white
  // pixels out of 31410 — and the whole suite stayed green, because no fixture
  // used the White swatch (whose tooltip is literally "for dark sketch areas").
  // This measures the luminance SPREAD inside the box instead, which is what
  // "you can read it" actually means and is colour-agnostic.
  const palette = await s.eval(`(async () => {
    const { d, settle, contrast } = window.__NC;
    const img = d.getImages()[0];
    const out = {};
    const colors = ['red', 'blue', 'black', 'white'];
    // One clear spot, reused: each note is added, measured, then UNDONE, so the
    // four never overlap each other or the fixtures from the earlier sections.
    const at = { x: img.x + img.width * 0.66, y: img.y + img.height * 0.03 };
    const before = d.getNotes().length;
    for (let i = 0; i < colors.length; i += 1) {
      d.addNote('READABLE', at, { color: colors[i], fontSize: 12, boxWidth: 120 });
      await settle();
      // Inside the box, past the border, across the glyph row.
      out[colors[i]] = contrast({ x: at.x + 2, y: at.y + 2, width: 55, height: 15 });
      document.getElementById('undoBtn').click();
      await settle();
      await new Promise(r => setTimeout(r, 90));
    }
    out.noteCountRestored = d.getNotes().length === before;
    out.before = before;
    out.after = d.getNotes().length;
    return out;
  })()`);
  check(palette.noteCountRestored === true,
    `undo did not clean up the palette fixtures: ${palette.before} notes before, ${palette.after} after`);
  for (const color of ['red', 'blue', 'black', 'white']) {
    const c = palette[color];
    check(c && !c.offscreen, `the ${color} note sample fell outside the canvas`);
    check(c.spread > 90,
      `a ${color} note is not readable: luminance spread inside its box is only ${c.spread.toFixed(0)} (min ${c.min.toFixed(0)}, max ${c.max.toFixed(0)}) — the text does not stand out from its own ground`);
  }
  console.log(`notes-check: all four palette colours readable (spread red ${palette.red.spread.toFixed(0)}, blue ${palette.blue.spread.toFixed(0)}, black ${palette.black.spread.toFixed(0)}, white ${palette.white.spread.toFixed(0)})`);

  // ---- 4. Notes render in Auto Mode too ----------------------------------
  // They are board content, not a Manual-mode overlay: a TD reviewing drafts
  // must still see the remarks written on the sketch, even though the Text
  // tool itself is Manual-only.
  const modes = await s.eval(`(async () => {
    const { d, settle, countColor } = window.__NC;
    const img = d.getImages()[0];
    const region = { x: img.x + img.width * 0.12 - 4, y: img.y + img.height * 0.20 - 4, width: 180, height: 70 };
    const manual = countColor(region, [230,57,57], 26).count;
    document.getElementById('modeAutoBtn').click();
    await settle();
    const auto = countColor(region, [230,57,57], 26).count;
    document.getElementById('modeManualBtn').click();
    await settle();
    return { manual, auto, backToManual: countColor(region, [230,57,57], 26).count };
  })()`);
  check(modes.manual > 40 && modes.auto > 40,
    `notes must render in both modes: manual ${modes.manual} px, auto ${modes.auto} px`);
  check(Math.abs(modes.auto - modes.manual) <= Math.max(4, modes.manual * 0.02),
    `the note rendered differently in Auto Mode (${modes.manual} -> ${modes.auto} px)`);
  check(modes.backToManual > 40, 'the note vanished on the way back to Manual Mode');
  console.log(`notes-check: identical in both modes (${modes.manual} px manual, ${modes.auto} px auto)`);

  // ---- 5. Notes stay out of the measurement set ---------------------------
  const isolation = await s.eval(`(() => ({
    annotations: window.__braAutoModeDebug.getAnnotations().length,
    notes: window.__braAutoModeDebug.getNotes().length,
    deletedPomKeys: window.__braAutoModeDebug.exportProject().state.deletedPomKeys.length,
  }))()`);
  check(isolation.notes === 2, `expected the 2 notes this run left on the board, got ${isolation.notes}`);
  check(isolation.annotations === 0,
    `notes leaked into the measurement set: ${isolation.annotations} annotations exist`);
  check(isolation.deletedPomKeys === 0, 'notes wrote into deletedPomKeys');

  // ---- 5b. The note ships in the export, and widens the frame ------------
  // Measured on the exported PNG's own pixels, decoded back in-page. The note
  // is placed OUTSIDE the photo on purpose: that is the case where the export
  // has to grow to hold it, and the case a bounds miss would silently crop —
  // delivering a tech pack whose sketch is missing the instruction written on
  // it, with nothing on screen to hint at the loss.
  const exported = await s.eval(`(async () => {
    const { d, settle } = window.__NC;
    const img = d.getImages()[0];
    const decode = async () => {
      const url = d.exportBoardDataUrl();
      const im = new Image();
      im.src = url;
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height).data;
      let blue = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - 37) <= 26 && Math.abs(data[i+1] - 99) <= 26 && Math.abs(data[i+2] - 235) <= 26) blue += 1;
      }
      return { w: c.width, h: c.height, blue };
    };
    const annIdsBefore = d.getExportAnnIds();
    const before = await decode();
    // Clear of the photo entirely, to its right, with a leader reaching back in.
    const at = { x: img.x + img.width + 40, y: img.y + img.height * 0.3 };
    d.addNote('SHIP THIS NOTE', at,
      { color: 'blue', fontSize: 14, boxWidth: 150, leaders: [{ x: img.x + img.width * 0.8, y: img.y + img.height * 0.5 }] });
    await settle();
    const after = await decode();
    const annIdsAfter = d.getExportAnnIds();
    document.getElementById('undoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 120));
    return { before, after, annIdsBefore, annIdsAfter, notesLeft: d.getNotes().length };
  })()`);
  // A delta, not an absolute: section 2's leader note is blue and still on the
  // board, so "zero blue before" is not available. The baseline is fixed and
  // measured in the same run, which is what makes the comparison meaningful.
  check(exported.before.blue > 0,
    'the earlier blue fixture is missing from the export — the baseline is wrong, not the note');
  check(exported.after.blue - exported.before.blue > 60,
    `the note did not reach the export: blue px went ${exported.before.blue} -> ${exported.after.blue}`);
  check(exported.after.w > exported.before.w,
    `the export frame did not grow for a note outside the photo (${exported.before.w}px -> ${exported.after.w}px) — it would be cropped`);
  check(JSON.stringify(exported.annIdsAfter) === JSON.stringify(exported.annIdsBefore),
    `adding a note changed the exported POM set: ${JSON.stringify(exported.annIdsBefore)} -> ${JSON.stringify(exported.annIdsAfter)}`);
  console.log(`notes-check: the note ships in the export (+${exported.after.blue - exported.before.blue} blue px) and widened the frame ${exported.before.w} -> ${exported.after.w}px, POM set untouched`);

  // ---- 6. Reset Board takes the notes, and one Undo brings them back ------
  // The only landed code path that DESTROYS notes. It is also the path where
  // "notes count as board content" first became load-bearing: isWorkingBoardEmpty
  // decides whether the control is even offered, so on a notes-only board the
  // button has to be live or the notes become unremovable.
  const reset = await s.eval(`(async () => {
    const { d, settle } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const before = { notes: d.getNotes().length, images: d.getImages().length };
      document.getElementById('autoResetBoardBtn').click();
      await settle();
      await new Promise(r => setTimeout(r, 120));
      const after = { notes: d.getNotes().length, images: d.getImages().length };
      document.getElementById('undoBtn').click();
      await settle();
      await new Promise(r => setTimeout(r, 160));
      const undone = { notes: d.getNotes().length, images: d.getImages().length };
      return { before, after, undone };
    } finally {
      window.confirm = realConfirm;
    }
  })()`);
  check(reset.before.notes > 0, 'nothing to reset — the earlier sections left no notes');
  check(reset.after.notes === 0,
    `Reset Board left ${reset.after.notes} notes behind — it wipes photos and lines, so a stale note would survive onto a fresh sketch`);
  check(reset.undone.notes === reset.before.notes,
    `one Undo did not bring the notes back: ${reset.before.notes} before, ${reset.undone.notes} after undo`);
  check(reset.undone.images === reset.before.images,
    'Undo restored the notes but not the photo — the reset must be a single history step');
  console.log(`notes-check: Reset Board clears ${reset.before.notes} notes and one Undo restores all ${reset.undone.notes}`);

  // ========================================================================
  // 7. The pointer layer (step 5): the Text tool, the editor, and the press
  //    chain. Every gesture here is a real MouseEvent on the canvas.
  //
  //    Runs last and on a REBUILT board: the sections above deliberately leave
  //    notes and a leader lying around, and a press-priority claim measured on
  //    a crowded board proves nothing about which rule won.
  // ========================================================================
  const stage = await s.eval(`(async () => {
    const { d, settle, solidImage } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { document.getElementById('autoResetBoardBtn').click(); await settle(); }
    finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 120));
    await d.addBoardImages([solidImage('#f2f2f2', 600, 400)]);
    document.getElementById('modeManualBtn').click();
    await settle();
    document.getElementById('toolSelect').click();
    document.getElementById('colorRedBtn').click();
    await settle();
    return { notes: d.getNotes().length, images: d.getImages().length,
      annotations: d.getAnnotations().length, img: d.getImages()[0], view: d.getView() };
  })()`);
  check(stage.notes === 0 && stage.annotations === 0 && stage.images === 1,
    `the step-5 stage did not start clean: ${JSON.stringify({ notes: stage.notes, annotations: stage.annotations, images: stage.images })}`);

  // ---- 7a. The Text tool: reachable by button and by T, Manual-only -------
  const tool = await s.eval(`(async () => {
    const { d, settle } = window.__NC;
    document.getElementById('toolText').click(); await settle();
    const byButton = d.getState().tool;
    document.getElementById('toolSelect').click(); await settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true })); await settle();
    const byKey = d.getState().tool;
    // Auto Mode must refuse it — notes are Manual-only to CREATE (they still
    // render in Auto, which section 4 covers).
    document.getElementById('modeAutoBtn').click(); await settle();
    const disabledInAuto = document.getElementById('toolText').disabled;
    document.getElementById('toolText').click(); await settle();
    const toolInAuto = d.getState().tool;
    document.getElementById('modeManualBtn').click(); await settle();
    document.getElementById('toolSelect').click(); await settle();
    return { byButton, byKey, disabledInAuto, toolInAuto };
  })()`);
  check(tool.byButton === 'text', `the toolbar button did not select the Text tool (tool is ${tool.byButton})`);
  check(tool.byKey === 'text', `the T shortcut did not select the Text tool (tool is ${tool.byKey})`);
  check(tool.disabledInAuto === true, 'the Text tool button is still enabled in Auto Mode');
  check(tool.toolInAuto === 'select', `Auto Mode accepted the Text tool (tool became ${tool.toolInAuto})`);
  console.log('notes-check: Text tool reachable by button and T, refused in Auto');

  // ---- 7b. Click -> editor -> typed text becomes a note AT THAT POINT -----
  // The position claim is the one that matters: an editor that opens in the
  // right place but commits somewhere else produces a note the TD then has to
  // hunt for, and no state-only assertion would notice.
  const create = await s.eval(`(async () => {
    const { d, settle, down, up, typeInto, commitEditor, countColor } = window.__NC;
    const img = d.getImages()[0];
    const at = { x: img.x + img.width * 0.10, y: img.y + img.height * 0.12 };
    const region = { x: at.x - 4, y: at.y - 4, width: 170, height: 60 };
    const before = countColor(region, [230,57,57], 26).count;
    document.getElementById('toolText').click(); await settle();
    down(at.x, at.y); up(at.x, at.y); await settle();
    const editor = d.getNoteEditor();
    const focused = document.activeElement === document.getElementById('noteEditor');
    typeInto(document.getElementById('noteEditor'), 'Bartack here\\nboth sides');
    // Where the editor actually sits on screen, captured while it is open. The
    // committed note's top-left has to land on the same point: note.pos IS the
    // box's top-left, so an editor centred on it the way #labelEditor is would
    // put every note half a box away from where the TD watched themselves type.
    const editorRect = document.getElementById('noteEditor').getBoundingClientRect();
    await commitEditor();
    const notes = d.getNotes();
    const note = notes[notes.length - 1];
    const v = d.getView();
    const canvasRect = document.getElementById('boardCanvas').getBoundingClientRect();
    const noteScreen = { x: note.pos.x * v.zoom + v.panX + canvasRect.left,
      y: note.pos.y * v.zoom + v.panY + canvasRect.top };
    return {
      editor, focused, at, count: notes.length, note, before,
      editorOffset: { x: noteScreen.x - editorRect.left, y: noteScreen.y - editorRect.top },
      after: countColor(region, [230,57,57], 26).count,
      screenFont: note ? note.fontSize * d.getView().zoom : 0,
      zoom: d.getView().zoom,
      editorAfter: d.getNoteEditor(),
    };
  })()`);
  check(create.editor && create.editor.mode === 'create',
    `the Text tool click did not open a create-mode editor: ${JSON.stringify(create.editor)}`);
  check(create.focused === true, 'the note editor opened without focus — the TD would type into the board');
  check(create.count === 1, `the commit did not produce exactly one note (got ${create.count})`);
  check(create.note.text === 'Bartack here\nboth sides',
    `the typed text did not survive the commit: ${JSON.stringify(create.note.text)}`);
  check(Math.abs(create.note.pos.x - create.at.x) < 1 && Math.abs(create.note.pos.y - create.at.y) < 1,
    `the note did not land where it was clicked: clicked (${create.at.x.toFixed(1)}, ${create.at.y.toFixed(1)}), got (${create.note.pos.x.toFixed(1)}, ${create.note.pos.y.toFixed(1)})`);
  check(create.note.appearance === 'text-only' && create.note.textColor === 'black'
    && create.note.leaderColor === 'red' && create.note.widthMode === 'fixed',
    `a pointer-created note did not receive the approved defaults: ${JSON.stringify(create.note)}`);
  check(create.editorAfter === null, 'the editor stayed open after a commit');
  check(Math.abs(create.editorOffset.x) < 2 && Math.abs(create.editorOffset.y) < 2,
    `the committed note did not land where the editor was: offset (${create.editorOffset.x.toFixed(1)}, ${create.editorOffset.y.toFixed(1)}) px on screen`);
  // A note is world geometry, so at zoom 2 a fixed 16 world-px default would be
  // written at 32 screen px; at zoom 0.3, at 5. The creation path compensates so
  // a new note is always born legible, and only THEN scales with the sketch.
  check(Math.abs(create.screenFont - 16) < 0.6,
    `a new note was not born at the default SCREEN size: ${create.screenFont.toFixed(1)}px on screen (fontSize ${create.note.fontSize.toFixed(2)} at zoom ${create.zoom.toFixed(2)})`);
  console.log(`notes-check: a Text-tool click created a transparent black/red note at the click point, born at ${create.screenFont.toFixed(1)} screen px (zoom ${create.zoom.toFixed(2)})`);

  // ---- 7c. An empty commit creates nothing -------------------------------
  const empty = await s.eval(`(async () => {
    const { d, settle, down, up, commitEditor } = window.__NC;
    const img = d.getImages()[0];
    const before = d.getNotes().length;
    down(img.x + img.width * 0.70, img.y + img.height * 0.08);
    up(img.x + img.width * 0.70, img.y + img.height * 0.08);
    await settle();
    const opened = !!d.getNoteEditor();
    await commitEditor();
    document.getElementById('toolSelect').click(); await settle();
    return { before, opened, after: d.getNotes().length };
  })()`);
  check(empty.opened === true, 'the second Text-tool click did not open an editor');
  check(empty.after === empty.before,
    `an empty commit created a note: ${empty.before} -> ${empty.after}`);
  console.log('notes-check: an empty commit creates nothing');

  // ---- 7c2. The EDITOR is readable in every palette colour ---------------
  // The audit bug from step 2, one layer up: white ink on the white ground
  // rendered a blank chip, and 25 assertions stayed green because no fixture
  // used the White swatch. The editor is a second surface with the same trap —
  // and a worse one, because the TD is typing into it and cannot see the
  // characters at all. Measured as the luminance gap between the editor's own
  // computed ink and ground, so it is colour-agnostic like section 3b.
  const editorInk = await s.eval(`(async () => {
    const { d, settle, down, up } = window.__NC;
    const img = d.getImages()[0];
    const lum = (css) => {
      const m = css.match(/[\\d.]+/g).map(Number);
      return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
    };
    const out = {};
    for (const color of ['red', 'blue', 'black', 'white']) {
      d.setNoteTextColor(color);
      await settle();
      document.getElementById('toolText').click(); await settle();
      down(img.x + img.width * 0.75, img.y + img.height * 0.75);
      up(img.x + img.width * 0.75, img.y + img.height * 0.75);
      await settle();
      const cs = getComputedStyle(document.getElementById('noteEditor'));
      out[color] = { gap: Math.abs(lum(cs.color) - lum(cs.backgroundColor)), open: !!d.getNoteEditor() };
      document.getElementById('noteEditor')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
    }
    d.setNoteTextColor('black');
    document.getElementById('toolSelect').click(); await settle();
    out.stillClosed = d.getNoteEditor() === null;
    return out;
  })()`);
  for (const color of ['red', 'blue', 'black', 'white']) {
    check(editorInk[color].open === true, `the ${color} editor never opened — its contrast reading is meaningless`);
    check(editorInk[color].gap > 90,
      `typing a ${color} note is invisible: only ${editorInk[color].gap.toFixed(0)} luminance between the editor's text and its own background`);
  }
  check(editorInk.stillClosed === true, 'Escape did not cancel the note editor');
  console.log(`notes-check: the editor stays readable in all four colours (gaps ${['red','blue','black','white'].map(c => editorInk[c].gap.toFixed(0)).join('/')}) and Escape cancels it`);

  // ---- 7d. Select, and DO NOT move on the selecting press ----------------
  const select = await s.eval(`(async () => {
    const { d, settle, down, move, up, drag } = window.__NC;
    const n0 = d.getNotes()[0];
    const grab = { x: n0.pos.x + 12, y: n0.pos.y + 8 };
    down(grab.x, grab.y);
    const opened = d.getInteraction();
    // Hand jitter, deliberately inside the 3px arming grace. WITHOUT this the
    // "the selecting press did not move it" assertion below is vacuous — a
    // press with no mousemove at all cannot move anything, armed or not, so it
    // would pass with the arming removed.
    move(grab.x + 1.2, grab.y + 0.8);
    up(grab.x + 1.2, grab.y + 0.8);
    await settle();
    const afterClick = d.getNotes()[0].pos;
    const selection = d.getState().selection;
    const seen = await drag(grab.x, grab.y, grab.x + 60, grab.y + 35);
    const afterDrag = d.getNotes()[0].pos;
    document.getElementById('undoBtn').click(); await settle();
    await new Promise(r => setTimeout(r, 120));
    const afterUndo = d.getNotes()[0].pos;
    return {
      opened, selection, noteId: n0.id, start: n0.pos, afterClick, afterDrag, afterUndo,
      dragSeen: seen,
    };
  })()`);
  check(select.opened && select.opened.type === 'drag-note',
    `a press on the note box did not open a note drag: ${JSON.stringify(select.opened)}`);
  check(select.selection.kind === 'note' && select.selection.id === select.noteId,
    `the press selected the wrong thing: ${JSON.stringify(select.selection)}`);
  check(Math.abs(select.afterClick.x - select.start.x) < 0.01
    && Math.abs(select.afterClick.y - select.start.y) < 0.01,
    `the SELECTING press moved the note (${select.start.x.toFixed(2)} -> ${select.afterClick.x.toFixed(2)}) — the 3px arming grace is not applied`);
  check(Math.abs((select.afterDrag.x - select.afterClick.x) - 60) < 4
    && Math.abs((select.afterDrag.y - select.afterClick.y) - 35) < 4,
    `the drag did not move the note by the pointer delta: expected (+60, +35), got (${(select.afterDrag.x - select.afterClick.x).toFixed(1)}, ${(select.afterDrag.y - select.afterClick.y).toFixed(1)})`);
  check(Math.abs(select.afterUndo.x - select.afterClick.x) < 0.5
    && Math.abs(select.afterUndo.y - select.afterClick.y) < 0.5,
    `one Undo did not put the note back: ${JSON.stringify(select.afterUndo)} vs ${JSON.stringify(select.afterClick)}`);
  console.log(`notes-check: the note selects without moving, drags by the pointer delta, and one Undo restores it`);

  // ---- 7e. Press priority: note beats the PHOTO, endpoint beats the note --
  // The two halves of the rule, measured as the gesture each press OPENED —
  // "nothing moved" cannot tell a note drag from a photo drag that carried the
  // note along, which is exactly the ambiguity US-089 was fixed for.
  const priority = await s.eval(`(async () => {
    const { d, settle, down, up } = window.__NC;
    const img = d.getImages()[0];
    // A VERTICAL line drawn with the real straight tool, so its endpoint is a
    // real one. Vertical on purpose: the callout number sits near the line's
    // midpoint, and the first version of this fixture ran the line horizontally
    // through where the note goes — the press landed on the selected line's
    // LABEL and opened a label drag, which is the documented priority working
    // correctly on an ambiguous fixture. Keeping the label 0.2 * height clear of
    // the note box removes the ambiguity instead of loosening the assertion.
    const a = { x: img.x + img.width * 0.30, y: img.y + img.height * 0.30 };
    const b = { x: img.x + img.width * 0.30, y: img.y + img.height * 0.70 };
    document.getElementById('toolStraight').click(); await settle();
    down(a.x, a.y); up(a.x, a.y); await settle();
    down(b.x, b.y); up(b.x, b.y); await settle();
    document.getElementById('toolSelect').click(); await settle();
    // Drop the fresh line's selection, so the endpoint below is claimed by the
    // any-visible-endpoint rule (US-086) rather than by the selected line's own
    // handle test — that is the rule a TD actually meets first.
    down(img.x - 90, img.y - 60); up(img.x - 90, img.y - 60); await settle();
    const lines = d.getAnnotations().length;
    // A note whose BOX covers that endpoint. Wide text so the box is wide.
    const note = d.addNote('COVERING THE ENDPOINT', { x: b.x - 30, y: b.y - 16 },
      { color: 'red', fontSize: 13, boxWidth: 200 });
    await settle();
    document.getElementById('toolSelect').click(); await settle();
    // 1. deep inside the note box, clear of the endpoint and of the line body.
    const inBox = { x: note.pos.x + 110, y: note.pos.y + 6 };
    down(inBox.x, inBox.y); const onNote = d.getInteraction(); up(inBox.x, inBox.y); await settle();
    // 2. exactly on the line's endpoint, which the note box covers.
    down(b.x, b.y); const onEndpoint = d.getInteraction(); up(b.x, b.y); await settle();
    // 3. the note sits on the photo: a press in the box must never drag it.
    const photoBefore = { x: d.getImages()[0].x, y: d.getImages()[0].y };
    down(inBox.x, inBox.y); const again = d.getInteraction(); up(inBox.x, inBox.y); await settle();
    const photoAfter = { x: d.getImages()[0].x, y: d.getImages()[0].y };
    // Audit-found gap: this used to be b.x > note.pos.x && b.x < note.pos.x+200
    // (etc), and note.pos was constructed a few lines up as literally
    // b.x-30/b.y-16 — substitute that in and the check collapses to the
    // constant "30 > 0 && 30 < 200 && 16 > 0 && 16 < 40", true no matter what
    // the RENDERED box measures. It could never have caught the regression it
    // exists to catch (NOTE_PADDING_RATIO tightened, a shorter fixture string,
    // any change that shrinks the real box under the endpoint). getNoteHandles
    // returns the box noteBounds() actually measured, the same seam section 8
    // already uses for exactly this reason.
    const realBox = d.getNoteHandles(note.id).box;
    return { lines, onNote, onEndpoint, again, photoBefore, photoAfter, noteId: note.id, realBox,
      boxCoversEndpoint: !!realBox && b.x > realBox.x && b.x < realBox.x + realBox.width
        && b.y > realBox.y && b.y < realBox.y + realBox.height };
  })()`);
  check(priority.lines === 1, `the straight tool did not draw the fixture line (${priority.lines} lines)`);
  check(priority.boxCoversEndpoint === true, 'the fixture note does not cover the endpoint — the next check would be vacuous');
  check(priority.onNote && priority.onNote.type === 'drag-note',
    `a press inside the note box did not take the note: ${JSON.stringify(priority.onNote)}`);
  check(priority.onEndpoint && priority.onEndpoint.type === 'drag-handle',
    `the line endpoint under the note box was unreachable — the press opened ${JSON.stringify(priority.onEndpoint)} instead of a handle drag`);
  check(priority.again && priority.again.type === 'drag-note',
    `a repeat press in the note box opened ${JSON.stringify(priority.again)} — the photo behind it claimed the click`);
  check(priority.photoAfter.x === priority.photoBefore.x && priority.photoAfter.y === priority.photoBefore.y,
    'pressing a note that sits on the sketch moved the sketch');
  console.log('notes-check: the note box beats the photo, the line endpoint beats the note box');

  // ---- 7e2. The SELECTED note's own handles beat a nearby line endpoint ---
  // Audit-found gap: 7e above only proves the OPPOSITE-direction rule (a line
  // endpoint beats a note's plain BOX). The press-priority design also puts a
  // SELECTED note's leader tip / leader-add handle ABOVE any line endpoint —
  // hitTestSelectedNoteHandles runs before hitTestAnyEndpoint in onMouseDown,
  // specifically so a leader dropped near a line's end stays grabbable — and
  // nothing exercised that half. A merge of the two (now-split) hit-test
  // functions back into one, in the wrong order, would make a leader tip near
  // a line endpoint permanently ungrabbable while every OTHER assertion in
  // this file kept passing.
  const handleBeatsEndpoint = await s.eval(`(async () => {
    const { d, settle, down, move, up } = window.__NC;
    const img = d.getImages()[0];
    const id = ${priority.noteId};
    const b = { x: img.x + img.width * 0.30, y: img.y + img.height * 0.70 };
    document.getElementById('toolSelect').click(); await settle();
    const noteNow = d.getNotes().find(n => n.id === id);
    // Re-select it explicitly — independent of whatever 7e's own presses left
    // as the current selection.
    down(noteNow.pos.x + 20, noteNow.pos.y + 8); up(noteNow.pos.x + 20, noteNow.pos.y + 8); await settle();
    const selection = d.getState().selection;
    const z = d.getView().zoom;
    const h = d.getNoteHandles(id);
    // Drag a new arrow from the + handle to land EXACTLY on the line's
    // endpoint — distance 0 from both the leader-tip catch circle and the
    // endpoint's own catch circle, so whichever hit-test runs FIRST wins.
    down(h.add.x, h.add.y);
    move(h.add.x + 1 / z, h.add.y + 1 / z);
    move(b.x, b.y);
    up(b.x, b.y);
    await settle();
    down(b.x, b.y);
    const opened = d.getInteraction();
    up(b.x, b.y);
    await settle();
    const leaders = d.getNotes().find(n => n.id === id).leaders;
    // Clean up: drop the probe arrow so it does not linger into 7f/section 8's
    // fixtures, which count leaders from a known-empty starting point.
    document.getElementById('undoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 140));
    return { selection, opened, leaderCount: leaders.length,
      tip: leaders[0] || null, b, restored: d.getNotes().find(n => n.id === id).leaders.length };
  })()`);
  check(handleBeatsEndpoint.selection.kind === 'note',
    `the note could not be re-selected: ${JSON.stringify(handleBeatsEndpoint.selection)}`);
  check(handleBeatsEndpoint.leaderCount === 1
    && Math.abs(handleBeatsEndpoint.tip.x - handleBeatsEndpoint.b.x) < 0.5
    && Math.abs(handleBeatsEndpoint.tip.y - handleBeatsEndpoint.b.y) < 0.5,
    'the probe arrow did not land exactly on the line endpoint — the next check would be ambiguous');
  check(handleBeatsEndpoint.opened && handleBeatsEndpoint.opened.type === 'drag-note-leader',
    `a leader tip sitting exactly on a line endpoint lost to the endpoint: ${JSON.stringify(handleBeatsEndpoint.opened)}`);
  check(handleBeatsEndpoint.restored === 0, 'the probe arrow was not cleaned up');
  console.log(`notes-check: a selected note's own leader tip beats a line endpoint sitting on top of it`);

  // ---- 7f. Double-click edits; a click on the board commits ---------------
  // The subtlest path in the step. Blur cannot own the click-away commit: the
  // focus change is a default action of mousedown, so blur lands AFTER the
  // canvas handler. Getting it wrong produces either a lost edit or a phantom
  // second note, so both are asserted.
  const edit = await s.eval(`(async () => {
    const { d, settle, dblclick, down, up, typeInto } = window.__NC;
    const target = d.getNotes().find(n => n.text.indexOf('Bartack') === 0);
    const before = d.getNotes().length;
    await dblclick(target.pos.x + 12, target.pos.y + 8);
    const editor = d.getNoteEditor();
    const box = document.getElementById('noteEditor');
    // Where the caret landed. Select-all — what the label editor does — would
    // mean the TD's next keystroke wipes a paragraph they already wrote.
    const caret = { start: box.selectionStart, end: box.selectionEnd, len: box.value.length };
    typeInto(document.getElementById('noteEditor'), 'Bartack here\\nboth sides\\nconfirm with TD');
    // Click far away on empty board: commits, and must NOT also place a note.
    const img = d.getImages()[0];
    down(img.x + img.width + 120, img.y + 20);
    up(img.x + img.width + 120, img.y + 20);
    await settle();
    const after = d.getNotes();
    const edited = after.find(n => n.id === target.id);
    return { editor, before, caret, count: after.length, text: edited ? edited.text : null,
      editorAfter: d.getNoteEditor(), targetId: target.id };
  })()`);
  check(edit.editor && edit.editor.mode === 'edit' && edit.editor.noteId === edit.targetId,
    `double-click did not open the note for editing: ${JSON.stringify(edit.editor)}`);
  check(edit.editor.value === 'Bartack here\nboth sides',
    `the editor did not load the note's existing text: ${JSON.stringify(edit.editor.value)}`);
  check(edit.editorAfter === null, 'the click on the board did not close the editor');
  check(edit.caret.start === edit.caret.len && edit.caret.end === edit.caret.len,
    `re-opening a note pre-selected its text (caret ${edit.caret.start}..${edit.caret.end} of ${edit.caret.len}) — the next keystroke would wipe what the TD wrote`);
  check(edit.text === 'Bartack here\nboth sides\nconfirm with TD',
    `the edit was lost on click-away: ${JSON.stringify(edit.text)}`);
  check(edit.count === edit.before,
    `the click that committed the edit also placed a note: ${edit.before} -> ${edit.count}`);
  console.log('notes-check: double-click edits, a click on the board commits it and creates nothing');

  // ---- 7g. Emptying a note removes it; Delete + Undo ---------------------
  const remove = await s.eval(`(async () => {
    const { d, settle, dblclick, down, up, typeInto, key } = window.__NC;
    const target = d.getNotes().find(n => n.text.indexOf('Bartack') === 0);
    const before = d.getNotes().length;
    await dblclick(target.pos.x + 12, target.pos.y + 8);
    typeInto(document.getElementById('noteEditor'), '   ');
    const img = d.getImages()[0];
    down(img.x + img.width + 120, img.y + 20); up(img.x + img.width + 120, img.y + 20);
    await settle();
    const afterEmpty = d.getNotes().length;
    document.getElementById('undoBtn').click(); await settle();
    await new Promise(r => setTimeout(r, 120));
    const afterUndo = d.getNotes().length;
    // Now the keyboard delete on a selected note.
    const again = d.getNotes().find(n => n.text.indexOf('Bartack') === 0);
    down(again.pos.x + 12, again.pos.y + 8); up(again.pos.x + 12, again.pos.y + 8); await settle();
    const selected = d.getState().selection;
    const deleteEnabled = !document.getElementById('deleteBtn').disabled;
    await key('Delete');
    const afterDelete = d.getNotes().length;
    const selectionAfter = d.getState().selection;
    document.getElementById('undoBtn').click(); await settle();
    await new Promise(r => setTimeout(r, 120));
    return { before, afterEmpty, afterUndo, selected, deleteEnabled, afterDelete, selectionAfter,
      restored: d.getNotes().length, annotations: d.getAnnotations().length,
      exportAnnIds: d.getExportAnnIds() };
  })()`);
  check(remove.afterEmpty === remove.before - 1,
    `emptying a note's text did not remove it: ${remove.before} -> ${remove.afterEmpty}`);
  check(remove.afterUndo === remove.before,
    `Undo did not bring the emptied note back: ${remove.afterUndo} vs ${remove.before}`);
  check(remove.selected.kind === 'note', 'the note could not be re-selected after the undo');
  check(remove.deleteEnabled === true, 'the toolbar Delete button stayed disabled with a note selected');
  check(remove.afterDelete === remove.before - 1,
    `Delete did not remove the selected note: ${remove.before} -> ${remove.afterDelete}`);
  check(remove.selectionAfter.kind === null, 'the selection survived the note it pointed at');
  check(remove.restored === remove.before, 'Undo did not restore the deleted note');
  // Through all of 7, exactly one line was drawn and it is still the whole
  // measurement set — nothing a note did touched what gets exported.
  check(remove.annotations === 1 && remove.exportAnnIds.length === 1,
    `the note work changed the measurement set: ${remove.annotations} annotations, exported ${JSON.stringify(remove.exportAnnIds)}`);
  console.log('notes-check: empty-edit removes, Delete removes, Undo restores, and the measurement set never moved');

  // ---- 7h. Selection chrome never reaches the export ---------------------
  // Step 5 is the first thing that paints something on TOP of a note. The
  // export renderers re-run the same drawing code with a redirected ctx, so a
  // helper drawn in the wrong pass would ship a dashed selection box inside the
  // tech pack — and it would only appear for whichever note the TD happened to
  // leave selected, which is exactly the kind of defect that reaches a factory.
  const chrome2 = await s.eval(`(async () => {
    const { d, settle, down, up } = window.__NC;
    // Count SELECT_COLOR (#356dff) pixels in the exported PNG. The
    // byte-comparison below cannot see chrome that is drawn for EVERY note —
    // both exports would carry it and still match — so the absolute count is
    // the assertion that actually holds, and the comparison only adds the
    // selection-dependent half.
    //
    // The tolerance is 6, NOT the 26 used for ink elsewhere, and that is
    // load-bearing: the Blue swatch (#2563eb) is close enough to SELECT_COLOR
    // that its ANTIALIASED edge pixels — measured, (69,122,238) — sit inside a
    // window of 18, so a blue note's own arrow read as 274 px of leaked chrome
    // whether it was selected or not. At 6 the two separate cleanly: blending
    // blue toward white lifts green into range only around 10% white, where the
    // blue channel is still ~237 against the 255 the select colour needs.
    // Real chrome is a solid fill and a 2px stroke, so it has exact-valued
    // pixels to spare — the controls below confirm it still fails when leaked.
    const selectPx = async () => {
      const im = new Image();
      im.src = d.exportBoardDataUrl();
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - 0x35) <= 6 && Math.abs(data[i+1] - 0x6d) <= 6 && Math.abs(data[i+2] - 0xff) <= 6) hits += 1;
      }
      return hits;
    };
    down(0, 0); up(0, 0); await settle();               // nothing selected
    const cleanUrl = d.exportBoardDataUrl();
    const cleanSelectPx = await selectPx();
    down(note0(d).pos.x + 12, note0(d).pos.y + 8); up(note0(d).pos.x + 12, note0(d).pos.y + 8); await settle();
    const selection = d.getState().selection;
    const selectedUrl = d.exportBoardDataUrl();
    const selectedSelectPx = await selectPx();
    return { same: cleanUrl === selectedUrl, selection, cleanSelectPx, selectedSelectPx };
    function note0(dd) { return dd.getNotes().find(n => n.text.indexOf('Bartack') === 0); }
  })()`);
  check(chrome2.selection.kind === 'note',
    `the export comparison never got a note selected: ${JSON.stringify(chrome2.selection)}`);
  check(chrome2.cleanSelectPx === 0 && chrome2.selectedSelectPx === 0,
    `selection chrome reached the exported board: ${chrome2.cleanSelectPx} select-coloured px unselected, ${chrome2.selectedSelectPx} with the note selected`);
  check(chrome2.same === true,
    'selecting a note changed the exported board — selection state is leaking into the export');
  console.log('notes-check: the export carries no selection chrome, selected or not');

  // ---- 7i. A note is not selectable in Auto Mode -------------------------
  const autoLock = await s.eval(`(async () => {
    const { d, settle, down, up } = window.__NC;
    const note = d.getNotes().find(n => n.text.indexOf('Bartack') === 0);
    document.getElementById('modeAutoBtn').click(); await settle();
    down(note.pos.x + 12, note.pos.y + 8);
    const opened = d.getInteraction();
    up(note.pos.x + 12, note.pos.y + 8);
    await settle();
    const selection = d.getState().selection;
    document.getElementById('modeManualBtn').click(); await settle();
    return { opened, selection };
  })()`);
  check(autoLock.selection.kind !== 'note',
    `Auto Mode selected a note: ${JSON.stringify(autoLock.selection)}`);
  check(!autoLock.opened || autoLock.opened.type !== 'drag-note',
    `Auto Mode opened a note drag: ${JSON.stringify(autoLock.opened)}`);
  console.log('notes-check: notes are inert in Auto Mode');

  // ========================================================================
  // 8. Leaders (step 6): pulling an arrow out of a note, moving its tip, and
  //    removing one. Self-contained on a rebuilt board, like section 7.
  //
  //    All aiming goes through getNoteHandles rather than arithmetic on
  //    pos + boxWidth: the box SHRINK-WRAPS to the measured text, so this note's
  //    box is 98.6 world px wide where boxWidth says 150. A test that computed
  //    the corner itself would aim 50px into empty canvas and quietly stop
  //    testing anything.
  //
  //    Offsets are in SCREEN pixels divided by zoom. Writing an 8-unit offset in
  //    WORLD units against an 11-SCREEN-px catch radius is how the first draft
  //    of this section missed the tip entirely — and the miss then selected the
  //    photo, so the next press dragged the sketch, which carried the note and
  //    its arrow along (US-089 working correctly) and looked like a leader bug.
  // ========================================================================
  const leaderStage = await s.eval(`(async () => {
    const { d, settle, solidImage, down, up, typeInto, commitEditor } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { document.getElementById('autoResetBoardBtn').click(); await settle(); }
    finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 120));
    await d.addBoardImages([solidImage('#f2f2f2', 600, 400)]);
    document.getElementById('modeManualBtn').click(); await settle();
    d.setNoteTextColor('black');
    d.setNoteLeaderColor('blue');
    document.getElementById('toolText').click(); await settle();
    const img = d.getImages()[0];
    const at = { x: img.x + img.width * 0.04, y: img.y + img.height * 0.06 };
    down(at.x, at.y); up(at.x, at.y); await settle();
    typeInto(document.getElementById('noteEditor'), 'Elastic 12mm\\npicot edge out');
    await commitEditor();
    document.getElementById('toolSelect').click(); await settle();
    const note = d.getNotes()[0];
    down(note.pos.x + 12, note.pos.y + 8); up(note.pos.x + 12, note.pos.y + 8); await settle();
    const handles = d.getNoteHandles(note.id);
    return { noteId: note.id, selection: d.getState().selection, handles,
      notes: d.getNotes().length, leaders: note.leaders.length };
  })()`);
  check(leaderStage.notes === 1 && leaderStage.leaders === 0,
    `the leader stage did not start with one arrow-less note: ${JSON.stringify(leaderStage)}`);
  check(leaderStage.selection.kind === 'note', 'the leader stage note is not selected');
  check(leaderStage.handles.add.x > leaderStage.handles.box.x + leaderStage.handles.box.width
    && leaderStage.handles.add.y > leaderStage.handles.box.y + leaderStage.handles.box.height,
    `the add handle is not outside the box's bottom-right corner: ${JSON.stringify(leaderStage.handles)}`);

  // ---- 8a. Drag the + handle out: one arrow, ending where it was dropped --
  const created = await s.eval(`(async () => {
    const { d, settle, down, move, up, countColor } = window.__NC;
    const img = d.getImages()[0];
    const id = ${leaderStage.noteId};
    const z = d.getView().zoom;
    // Dropped level with the note's vertical middle, so the arrow comes out of
    // the box's right edge running exactly HORIZONTALLY. That is not cosmetic:
    // the ink-thickness probe below samples a vertical strip, and the first
    // draft dropped the tip diagonally — the strip 70px back along the X axis
    // sat nowhere near the sloping leader and read 0, which looked like the
    // leader had not drawn at all.
    const box = d.getNoteHandles(id).box;
    const target = { x: img.x + img.width * 0.62, y: box.y + box.height / 2 };
    // Ink across the leader, 4 world px behind the tip and 70 back along it —
    // the same self-calibrating arrowhead test section 2 uses, so this proves
    // the pointer-made arrow is a real arrow and not just a line.
    const strip = (backBy) => ({ x: target.x - backBy, y: target.y - 14, width: 1.4, height: 28 });
    const before = countColor(strip(4), [37,99,235], 26).count;
    const h = d.getNoteHandles(id);
    down(h.add.x, h.add.y);
    move(h.add.x + 1 / z, h.add.y + 1 / z);
    move((h.add.x + target.x) / 2, (h.add.y + target.y) / 2);
    move(target.x, target.y);
    const opened = d.getInteraction();
    up(target.x, target.y);
    await settle();
    const leaders = d.getNotes()[0].leaders;
    return { opened, before, target, count: leaders.length,
      tip: leaders[0] || null,
      atArrow: countColor(strip(4), [37,99,235], 26),
      atShaft: countColor(strip(70), [37,99,235], 26) };
  })()`);
  check(created.opened && created.opened.type === 'drag-note-leader-new',
    `dragging the + handle did not open a new-leader drag: ${JSON.stringify(created.opened)}`);
  check(created.count === 1, `expected exactly one arrow, got ${created.count}`);
  check(Math.abs(created.tip.x - created.target.x) < 0.5 && Math.abs(created.tip.y - created.target.y) < 0.5,
    `the arrow did not end where it was dropped: dropped (${created.target.x.toFixed(1)}, ${created.target.y.toFixed(1)}), tip (${created.tip.x.toFixed(1)}, ${created.tip.y.toFixed(1)})`);
  check(created.before === 0, `the arrow's path was not clean before: ${created.before} blue px`);
  check(created.atShaft.count > 0 && created.atShaft.height > 0,
    'the pointer-made leader did not draw at all — the arrowhead comparison would be meaningless');
  check(created.atArrow.height >= created.atShaft.height * 2,
    `the pointer-made leader ends in a line, not an arrow: ${created.atArrow.height}px across at the tip vs ${created.atShaft.height}px along the shaft`);
  console.log(`notes-check: the + handle pulls out a real arrow (${created.atShaft.height}px shaft -> ${created.atArrow.height}px at the tip)`);

  // ---- 8a-undo. Undo/Redo cover the CREATE drag too -----------------------
  // Audit-found gap: 8d's Undo check exercises removeNoteLeader's own DIRECT
  // pushHistoryIfChanged() call — a completely separate code path from the
  // generic changed -> fingerprint-diff -> pushHistoryIfChanged() plumbing in
  // onMouseUp that the two DRAG interaction types actually rely on. Section 7d
  // proved that plumbing for the sibling drag-note type; section 8 never
  // repeated it for drag-note-leader-new. The two leader-drag branches are
  // also the only ones that set interaction.changed = true UNCONDITIONALLY
  // (every sibling drag branch gates it on `if (dx || dy)`), which is correct
  // today but is exactly the kind of thing an "make it consistent with the
  // others" refactor could quietly break.
  const createUndo = await s.eval(`(async () => {
    const { d, settle } = window.__NC;
    const before = d.getNotes()[0].leaders.length;
    document.getElementById('undoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 140));
    const afterUndo = d.getNotes()[0].leaders.length;
    document.getElementById('redoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 140));
    const afterRedo = d.getNotes()[0].leaders;
    return { before, afterUndo, afterRedoCount: afterRedo.length, tip: afterRedo[0] || null };
  })()`);
  check(createUndo.afterUndo === createUndo.before - 1,
    `Undo did not remove the pointer-created leader: ${createUndo.before} -> ${createUndo.afterUndo}`);
  check(createUndo.afterRedoCount === createUndo.before,
    `Redo did not bring the pointer-created leader back: ${createUndo.afterRedoCount} vs ${createUndo.before}`);
  check(createUndo.tip && Math.abs(createUndo.tip.x - created.tip.x) < 0.01 && Math.abs(createUndo.tip.y - created.tip.y) < 0.01,
    'Redo restored the leader at the wrong position');
  console.log('notes-check: Undo/Redo cover the pointer-driven leader CREATE too');

  // ---- 8a2. The + handle's catch radius is real, not a point match -------
  // Audit-found gap: every add-handle press elsewhere in this section (8a
  // above, 8b/8d below) lands at the EXACT {x,y} getNoteHandles reports —
  // distance 0 from the point the radius is measured against, which passes
  // for ANY positive radius, including a badly regressed one (1-2px, or a
  // forgotten "/ state.zoom"). 8c below already proves the TIP's catch radius
  // is real by grabbing off-centre; this is the same proof for the add
  // handle, which shares the identical `radius = 11 / state.zoom` constant in
  // hitTestSelectedNoteHandles but had never been exercised off-centre.
  const addOffCenter = await s.eval(`(async () => {
    const { d, settle, down, move, up } = window.__NC;
    const id = ${leaderStage.noteId};
    const z = d.getView().zoom;
    const img = d.getImages()[0];
    const before = d.getNotes()[0].leaders.length;
    const h = d.getNoteHandles(id);
    const off = { x: 4 / z, y: -3 / z };
    const grab = { x: h.add.x + off.x, y: h.add.y + off.y };
    const target = { x: img.x + img.width * 0.15, y: img.y + img.height * 0.15 };
    down(grab.x, grab.y);
    const opened = d.getInteraction();
    move(grab.x + 1 / z, grab.y + 1 / z);
    move(target.x, target.y);
    up(target.x, target.y);
    await settle();
    const afterLeaders = d.getNotes()[0].leaders;
    const landed = afterLeaders[afterLeaders.length - 1] || null;
    // Undo immediately so this probe leaves the leader count exactly where 8a
    // left it — the sections below index leaders[0] / expect an exact count
    // and must not see this extra arrow.
    document.getElementById('undoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 140));
    return { before, opened, after: afterLeaders.length, target, landed,
      restored: d.getNotes()[0].leaders.length };
  })()`);
  check(addOffCenter.opened && addOffCenter.opened.type === 'drag-note-leader-new',
    `a press 4 screen px off the + handle's centre missed it: ${JSON.stringify(addOffCenter.opened)}`);
  check(addOffCenter.after === addOffCenter.before + 1,
    `the off-centre press on the + handle did not create exactly one arrow: ${addOffCenter.before} -> ${addOffCenter.after}`);
  check(addOffCenter.landed
    && Math.abs(addOffCenter.landed.x - addOffCenter.target.x) < 0.5
    && Math.abs(addOffCenter.landed.y - addOffCenter.target.y) < 0.5,
    'the off-centre-grabbed arrow did not end where it was dropped');
  check(addOffCenter.restored === addOffCenter.before,
    `the probe's Undo did not clean up: ${addOffCenter.before} -> ${addOffCenter.after} -> ${addOffCenter.restored}`);
  console.log('notes-check: the + handle catch radius is real, not a point match');

  // ---- 8b. A click on the + handle creates nothing ------------------------
  // The leader is created on the frame the drag ARMS, not on the press, so a
  // stray click leaves no zero-length arrow pointing at the note's own corner.
  const stray = await s.eval(`(async () => {
    const { d, settle, down, move, up } = window.__NC;
    const id = ${leaderStage.noteId};
    const z = d.getView().zoom;
    const before = d.getNotes()[0].leaders.length;
    const h = d.getNoteHandles(id);
    down(h.add.x, h.add.y);
    const opened = d.getInteraction();
    // Hand jitter, inside the 3px arming grace — WITHOUT it this assertion is
    // vacuous, and was: a press with no mousemove at all creates nothing
    // whether the arming check is there or not, so a control that deleted the
    // check still passed. Same trap the select-press assertion hit in step 5.
    move(h.add.x + 2 / z, h.add.y + 1.4 / z);
    up(h.add.x + 2 / z, h.add.y + 1.4 / z);
    await settle();
    return { before, opened, after: d.getNotes()[0].leaders.length,
      selection: d.getState().selection };
  })()`);
  check(stray.opened && stray.opened.type === 'drag-note-leader-new',
    `the stray click did not even reach the + handle: ${JSON.stringify(stray.opened)}`);
  check(stray.after === stray.before,
    `a click on the + handle created an arrow: ${stray.before} -> ${stray.after}`);
  check(stray.selection.kind === 'note', 'the stray click dropped the note selection');
  console.log('notes-check: a click on the + handle creates nothing');

  // ---- 8c. Drag a tip: 1:1, no teleport, and the note stays put ----------
  const tipDrag = await s.eval(`(async () => {
    const { d, settle, down, move, up } = window.__NC;
    const id = ${leaderStage.noteId};
    const z = d.getView().zoom;
    const h0 = d.getNoteHandles(id);
    const tip = { x: h0.leaders[0].x, y: h0.leaders[0].y };
    const box0 = h0.box;
    // Grab 4 screen px off the tip — inside the 11 screen px catch radius, and
    // far enough that a missing grab offset would visibly snap the arrow.
    const off = { x: 4 / z, y: -3 / z };
    const grab = { x: tip.x + off.x, y: tip.y + off.y };
    const drop = { x: grab.x - 40, y: grab.y - 30 };
    down(grab.x, grab.y);
    move(grab.x + 1 / z, grab.y + 1 / z);
    move(drop.x, drop.y);
    const opened = d.getInteraction();
    up(drop.x, drop.y);
    await settle();
    const h1 = d.getNoteHandles(id);
    return { opened, tip, box0, box1: h1.box, moved: h1.leaders[0],
      expectedOffset: Math.hypot(off.x, off.y),
      distFromCursor: Math.hypot(h1.leaders[0].x - drop.x, h1.leaders[0].y - drop.y) };
  })()`);
  check(tipDrag.opened && tipDrag.opened.type === 'drag-note-leader',
    `grabbing the tip did not open a leader drag: ${JSON.stringify(tipDrag.opened)}`);
  check(Math.abs((tipDrag.moved.x - tipDrag.tip.x) + 40) < 1.5
    && Math.abs((tipDrag.moved.y - tipDrag.tip.y) + 30) < 1.5,
    `the tip did not track the pointer 1:1: expected (-40, -30), got (${(tipDrag.moved.x - tipDrag.tip.x).toFixed(1)}, ${(tipDrag.moved.y - tipDrag.tip.y).toFixed(1)})`);
  check(Math.abs(tipDrag.distFromCursor - tipDrag.expectedOffset) < 0.6,
    `the tip snapped to the cursor instead of keeping its grab offset: ${tipDrag.distFromCursor.toFixed(2)} away vs the ${tipDrag.expectedOffset.toFixed(2)} it was grabbed at`);
  check(Math.abs(tipDrag.box1.x - tipDrag.box0.x) < 0.01 && Math.abs(tipDrag.box1.y - tipDrag.box0.y) < 0.01,
    `moving the arrow's tip dragged the note with it: box went (${tipDrag.box0.x.toFixed(1)}, ${tipDrag.box0.y.toFixed(1)}) -> (${tipDrag.box1.x.toFixed(1)}, ${tipDrag.box1.y.toFixed(1)})`);
  console.log('notes-check: an arrow tip drags 1:1 without teleporting, and the note stays put');

  // ---- 8c-undo. Undo/Redo cover the pointer-driven tip DRAG too ----------
  // Same gap as 8a-undo, for drag-note-leader instead of drag-note-leader-new.
  const dragUndo = await s.eval(`(async () => {
    const { d, settle } = window.__NC;
    document.getElementById('undoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 140));
    const afterUndo = { ...d.getNotes()[0].leaders[0] };
    document.getElementById('redoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 140));
    const afterRedo = { ...d.getNotes()[0].leaders[0] };
    return { afterUndo, afterRedo };
  })()`);
  check(Math.abs(dragUndo.afterUndo.x - tipDrag.tip.x) < 0.5 && Math.abs(dragUndo.afterUndo.y - tipDrag.tip.y) < 0.5,
    `Undo did not revert the pointer-dragged tip: expected (${tipDrag.tip.x.toFixed(1)}, ${tipDrag.tip.y.toFixed(1)}), got (${dragUndo.afterUndo.x.toFixed(1)}, ${dragUndo.afterUndo.y.toFixed(1)})`);
  check(Math.abs(dragUndo.afterRedo.x - tipDrag.moved.x) < 0.5 && Math.abs(dragUndo.afterRedo.y - tipDrag.moved.y) < 0.5,
    `Redo did not restore the pointer-dragged tip's new position`);
  console.log('notes-check: Undo/Redo cover the pointer-driven leader DRAG too');

  // ---- 8d. Double-click one tip removes exactly that arrow ---------------
  const removal = await s.eval(`(async () => {
    const { d, settle, down, move, up, dblclick } = window.__NC;
    const id = ${leaderStage.noteId};
    const z = d.getView().zoom;
    const h = d.getNoteHandles(id);
    // A second arrow, well clear of the first.
    const t2 = { x: h.box.x + 250, y: h.box.y + 160 };
    down(h.add.x, h.add.y); move(h.add.x + 1 / z, h.add.y + 1 / z); move(t2.x, t2.y); up(t2.x, t2.y);
    await settle();
    const two = d.getNotes()[0].leaders.map(l => ({ x: l.x, y: l.y }));
    const now = d.getNoteHandles(id);
    await dblclick(now.leaders[0].x, now.leaders[0].y);
    const left = d.getNotes()[0].leaders.map(l => ({ x: l.x, y: l.y }));
    document.getElementById('undoBtn').click();
    await settle();
    await new Promise(r => setTimeout(r, 140));
    return { two, left, undone: d.getNotes()[0].leaders.length, notes: d.getNotes().length };
  })()`);
  check(removal.two.length === 2, `the second arrow was not created: ${removal.two.length} arrows`);
  check(removal.left.length === 1,
    `double-clicking a tip removed ${removal.two.length - removal.left.length} arrows, not exactly one`);
  check(Math.abs(removal.left[0].x - removal.two[1].x) < 0.01 && Math.abs(removal.left[0].y - removal.two[1].y) < 0.01,
    `double-click removed the WRONG arrow: survivor is ${JSON.stringify(removal.left[0])}, expected ${JSON.stringify(removal.two[1])}`);
  check(removal.notes === 1, 'double-clicking a tip removed the note itself, not just the arrow');
  check(removal.undone === 2, `one Undo did not bring the arrow back: ${removal.undone} arrows`);
  console.log('notes-check: double-clicking a tip removes exactly that arrow, and Undo restores it');

  // ---- 8e. Tip handles belong to the SELECTED note only ------------------
  // They are drawn only on the selected note, and a grabbable target that is
  // never drawn is worse than one that asks for a click first.
  const unselected = await s.eval(`(async () => {
    const { d, settle, down, move, up } = window.__NC;
    const id = ${leaderStage.noteId};
    const z = d.getView().zoom;
    const h = d.getNoteHandles(id);
    const tip = { x: h.leaders[0].x, y: h.leaders[0].y };
    const before = d.getNotes()[0].leaders.map(l => ({ x: l.x, y: l.y }));
    // Drop the selection on empty board, well clear of the photo and the note.
    const img = d.getImages()[0];
    down(img.x - 140, img.y - 110); up(img.x - 140, img.y - 110); await settle();
    const selection = d.getState().selection;
    down(tip.x, tip.y);
    const opened = d.getInteraction();
    move(tip.x - 30, tip.y - 20);
    up(tip.x - 30, tip.y - 20);
    await settle();
    const after = d.getNotes()[0].leaders.map(l => ({ x: l.x, y: l.y }));
    return { selection, opened, before, after };
  })()`);
  check(unselected.selection.kind === null,
    `the deselect click did not clear the selection: ${JSON.stringify(unselected.selection)}`);
  check(!unselected.opened || unselected.opened.type !== 'drag-note-leader',
    `an unselected note's tip was grabbable: ${JSON.stringify(unselected.opened)}`);
  check(Math.abs(unselected.after[0].x - unselected.before[0].x) < 0.01
    && Math.abs(unselected.after[0].y - unselected.before[0].y) < 0.01,
    'the arrow moved even though its note was not selected');
  console.log('notes-check: arrow handles belong to the selected note only');

  // ---- 8f. The arrows survive while the note is being edited -------------
  // The editor covers the box and text on purpose, but an arrow is not chrome:
  // it says what the note points at, which is what the TD is looking at while
  // deciding what to write.
  const whileEditing = await s.eval(`(async () => {
    const { d, settle, dblclick, down, move, up, countColor } = window.__NC;
    const id = ${leaderStage.noteId};
    const img = d.getImages()[0];
    const z = d.getView().zoom;
    // Two things this fixture has to set up before it can measure anything, both
    // learned the hard way. (1) Park the tip well INSIDE the photo: the previous
    // sections leave it near the board's edge, where a 32px sample is already
    // clipped (it read 57px where an unclipped arrowhead reads ~650). (2) Select
    // the note FIRST. Selecting reveals the contextual toolbar row, which
    // shortens the canvas by ~35px (US-088) — do that between the two samples
    // and the second one falls off the canvas and reads 0, which looks exactly
    // like the arrow having vanished.
    const box0 = d.getNoteHandles(id).box;
    down(box0.x + 12, box0.y + 8); up(box0.x + 12, box0.y + 8); await settle();
    const h0 = d.getNoteHandles(id);
    const safe = { x: img.x + img.width * 0.40, y: img.y + img.height * 0.55 };
    down(h0.leaders[0].x, h0.leaders[0].y);
    move(h0.leaders[0].x + 1 / z, h0.leaders[0].y + 1 / z);
    move(safe.x, safe.y);
    up(safe.x, safe.y);
    await settle();
    const h = d.getNoteHandles(id);
    const tip = h.leaders[0];
    const region = { x: tip.x - 16, y: tip.y - 16, width: 32, height: 32 };
    // Deselect before measuring "before": while selected, the tip's own grab
    // handle (drawn in SELECT_COLOR #356dff) sits in this exact region, and
    // #356dff is close enough to the blue swatch #2563eb to fall inside this
    // probe's 26-per-channel tolerance — so a SELECTED "before" sample was
    // silently counting chrome as ink. Editing already suppresses that chrome
    // (the fix section 9d below pins down); comparing a selected "before"
    // against an editing "during" used to compare arrow+chrome against
    // arrow-only and happened to net out only because the chrome bug being
    // fixed here made "during" carry the SAME stale chrome too. Deselecting
    // first makes both samples pure arrow ink.
    down(img.x - 140, img.y - 110); up(img.x - 140, img.y - 110); await settle();
    const before = countColor(region, [37,99,235], 26).count;
    await dblclick(h.box.x + 12, h.box.y + 8);
    const editing = !!d.getNoteEditor();
    const during = countColor(region, [37,99,235], 26).count;
    document.getElementById('noteEditor')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    return { before, during, editing, closed: d.getNoteEditor() === null };
  })()`);
  check(whileEditing.editing === true, 'the double-click did not open the editor — the next check would be vacuous');
  check(whileEditing.before > 20, `the arrowhead was not on screen to begin with: ${whileEditing.before} px`);
  check(whileEditing.during >= whileEditing.before * 0.9,
    `the arrow vanished while its note was being edited: ${whileEditing.before} -> ${whileEditing.during} blue px`);
  check(whileEditing.closed === true, 'Escape did not close the editor');
  console.log(`notes-check: arrows stay drawn while the note is edited (${whileEditing.before} -> ${whileEditing.during} px)`);

  // ---- 8g. Arrows ship in the export; their handles do not ---------------
  const leaderExport = await s.eval(`(async () => {
    const { d, settle, down, up } = window.__NC;
    const id = ${leaderStage.noteId};
    const decode = async () => {
      const im = new Image();
      im.src = d.exportBoardDataUrl();
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let blue = 0, select = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - 37) <= 26 && Math.abs(data[i+1] - 99) <= 26 && Math.abs(data[i+2] - 235) <= 26) blue += 1;
        // Tolerance 6, not 18 — see the note in section 7h: at 18 a blue note's
        // own antialiased arrow reads as leaked selection chrome.
        if (Math.abs(data[i] - 0x35) <= 6 && Math.abs(data[i+1] - 0x6d) <= 6 && Math.abs(data[i+2] - 0xff) <= 6) select += 1;
      }
      return { w: c.width, h: c.height, blue, select };
    };
    const annIdsBefore = d.getExportAnnIds();
    const withArrows = await decode();
    // Select the note so every handle is on screen, then export again.
    const h = d.getNoteHandles(id);
    down(h.box.x + 12, h.box.y + 8); up(h.box.x + 12, h.box.y + 8); await settle();
    const selected = d.getState().selection;
    const withHandles = await decode();
    // Now push one arrow far outside the photo: the frame has to grow for it.
    const img = d.getImages()[0];
    const far = { x: img.x + img.width + 220, y: img.y + img.height * 0.5 };
    const z = d.getView().zoom;
    const h2 = d.getNoteHandles(id);
    const grab = h2.leaders[0];
    down(grab.x, grab.y);
    window.__NC.move(grab.x + 1 / z, grab.y + 1 / z);
    window.__NC.move(far.x, far.y);
    up(far.x, far.y);
    await settle();
    const widened = await decode();
    return { annIdsBefore, annIdsAfter: d.getExportAnnIds(), withArrows, withHandles, widened, selected };
  })()`);
  check(leaderExport.selected.kind === 'note', 'the export comparison never got the note selected');
  check(leaderExport.withArrows.blue > 60,
    `the arrows are missing from the export: ${leaderExport.withArrows.blue} blue px`);
  check(leaderExport.withHandles.select === 0 && leaderExport.withArrows.select === 0,
    `the arrow handles reached the exported board: ${leaderExport.withHandles.select} select-coloured px with the note selected`);
  check(leaderExport.widened.w > leaderExport.withHandles.w,
    `the export frame did not grow for an arrow pointing outside the photo (${leaderExport.withHandles.w}px -> ${leaderExport.widened.w}px) — the arrow would be cropped`);
  check(JSON.stringify(leaderExport.annIdsAfter) === JSON.stringify(leaderExport.annIdsBefore),
    'the leader work changed the exported POM set');
  console.log(`notes-check: arrows ship (${leaderExport.withArrows.blue} px), their handles never do, and the frame grew ${leaderExport.withHandles.w} -> ${leaderExport.widened.w}px`);

  // ========================================================================
  // 9. Bugs found by an independent audit (2026-08-20), each pinned so it
  //    cannot silently return. All four were confirmed against the running
  //    app before being fixed; see the US-092 story doc's audit section for
  //    the verification detail behind each one.
  // ========================================================================

  // ---- 9a. Creating a note selects it, so Delete removes the NOTE, not a
  //          stale prior selection ----------------------------------------
  // Every OTHER creation gesture in this codebase selects what it just made (a
  // drawn line does, via handleDrawToolClick) — commitNoteEditor did not, so
  // switching to the Text tool with a line already selected left that line as
  // state.selection.kind even after the note was typed and committed, because
  // the Text tool deliberately stays active (no forced trip back to Select)
  // and setTool never clears a stale selection either. Pressing Delete then
  // removed the OLD LINE, not the note the TD just wrote — recoverable via
  // Undo, but with nothing on screen to say the wrong object went away.
  const stray9a = await s.eval(`(async () => {
    const { d, settle, solidImage, down, up, typeInto, commitEditor, key } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { document.getElementById('autoResetBoardBtn').click(); await settle(); }
    finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 120));
    await d.addBoardImages([solidImage('#f2f2f2', 500, 360)]);
    document.getElementById('modeManualBtn').click(); await settle();
    const img = d.getImages()[0];
    document.getElementById('toolStraight').click(); await settle();
    down(img.x + 40, img.y + 40); up(img.x + 40, img.y + 40); await settle();
    down(img.x + 200, img.y + 40); up(img.x + 200, img.y + 40); await settle();
    const selAfterLine = d.getState().selection;
    document.getElementById('toolText').click(); await settle();
    down(img.x + 40, img.y + 150); up(img.x + 40, img.y + 150); await settle();
    typeInto(document.getElementById('noteEditor'), 'a remark');
    await commitEditor();
    const selAfterNote = d.getState().selection;
    const before = { annotations: d.getAnnotations().length, notes: d.getNotes().length };
    document.getElementById('toolSelect').click(); await settle();
    await key('Delete');
    const after = { annotations: d.getAnnotations().length, notes: d.getNotes().length };
    return { selAfterLine, selAfterNote, before, after };
  })()`);
  check(stray9a.selAfterLine.kind === 'annotation', 'the fixture line was not selected after being drawn — the bug would be untestable');
  check(stray9a.selAfterNote.kind === 'note' && stray9a.selAfterNote.id !== stray9a.selAfterLine.id,
    `committing a new note did not select it: ${JSON.stringify(stray9a.selAfterNote)}`);
  check(stray9a.before.annotations === 1 && stray9a.before.notes === 1,
    `the 9a fixture did not start with one line and one note: ${JSON.stringify(stray9a.before)}`);
  check(stray9a.after.notes === 0,
    `Delete did not remove the note the TD just wrote: notes ${stray9a.before.notes} -> ${stray9a.after.notes}`);
  check(stray9a.after.annotations === 1,
    `Delete removed the line instead of the note: annotations ${stray9a.before.annotations} -> ${stray9a.after.annotations}`);
  console.log('notes-check: creating a note selects it, so Delete removes the note, not a stale prior selection');

  // ---- 9b. Group photo resize does not double-scale a note whose leader
  //          spans two grouped images -------------------------------------
  // resizeImagesFromCorner used to decide membership and apply the scale PER
  // IMAGE, in one pass. notesWithinBounds' membership rule (box centre in
  // bounds OR any leader tip in bounds) makes it ORDINARY — not a contrived
  // edge case — for a note whose box sits on one grouped photo and whose
  // arrow points at a neighbour to qualify under BOTH images' bounds at once,
  // so it was scaled twice per frame: since every grouped image tracks the
  // same shared factor, that compounds toward the SQUARE of the intended
  // scale over the course of a drag, silently detaching the note from the
  // feature its arrow points at. The fix de-duplicates by id first — the
  // resize counterpart of the Set startImageDrag already uses for a group PAN.
  const group9b = await s.eval(`(async () => {
    const { d, settle, solidImage, down, move, up, typeInto, commitEditor, toClient } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { document.getElementById('autoResetBoardBtn').click(); await settle(); }
    finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 120));
    await d.addBoardImages([solidImage('#eeeeee', 300, 220), solidImage('#dddddd', 300, 220)]);
    document.getElementById('modeManualBtn').click(); await settle();
    // getImages() returns a CLONE (so a test can read the board without racing
    // the render loop) — assigning to the objects it returns is a silent no-op
    // on the real state. addBoardImages already auto-places multiple photos
    // side by side with no overlap, so the fixture uses THAT real layout
    // rather than trying to override it.
    const imgs = d.getImages();
    document.getElementById('toolText').click(); await settle();
    // Note captioning photo A, its arrow pointing at photo B — the ordinary
    // "caption beside one photo, arrow into the neighbour" shape.
    const notePos = { x: imgs[0].x + 40, y: imgs[0].y + 40 };
    down(notePos.x, notePos.y); up(notePos.x, notePos.y); await settle();
    typeInto(document.getElementById('noteEditor'), 'caption');
    await commitEditor();
    document.getElementById('toolSelect').click(); await settle();
    const note = d.getNotes()[0];
    const z1 = d.getView().zoom;
    down(note.pos.x + 10, note.pos.y + 6); up(note.pos.x + 10, note.pos.y + 6); await settle();
    const h = d.getNoteHandles(note.id);
    const leaderTarget = { x: imgs[1].x + 40, y: imgs[1].y + 40 };
    down(h.add.x, h.add.y);
    move(h.add.x + 1 / z1, h.add.y + 1 / z1);
    move(leaderTarget.x, leaderTarget.y);
    up(leaderTarget.x, leaderTarget.y);
    await settle();
    const before = { pos: { ...d.getNotes()[0].pos }, fontSize: d.getNotes()[0].fontSize };
    const imagesBefore = d.getImages().map(im => ({ x: im.x, y: im.y, w: im.width, h: im.height }));
    const boxCentre = (() => {
      const b = d.getNoteHandles(note.id).box;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })();
    const inBounds = (p, box) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
    const leaderTip = d.getNotes()[0].leaders[0];
    const dualClaim = {
      boxInA: inBounds(boxCentre, imagesBefore[0]),
      leaderInB: inBounds(leaderTip, imagesBefore[1]),
    };

    // Group-select both photos (plain click + Cmd/Ctrl-click), then drag the
    // group's far corner outward — the real, shipped group-resize gesture.
    document.getElementById('toolSelect').click(); await settle();
    down(-200, -150); up(-200, -150); await settle();
    const centerA = { x: imagesBefore[0].x + imagesBefore[0].w / 2, y: imagesBefore[0].y + imagesBefore[0].h / 2 };
    const centerB = { x: imagesBefore[1].x + imagesBefore[1].w / 2, y: imagesBefore[1].y + imagesBefore[1].h / 2 };
    down(centerA.x, centerA.y); up(centerA.x, centerA.y); await settle();
    const pB = toClient(centerB.x, centerB.y);
    const canvas = document.getElementById('boardCanvas');
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: pB.x, clientY: pB.y, bubbles: true, button: 0, metaKey: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: pB.x, clientY: pB.y, bubbles: true, button: 0, metaKey: true }));
    await settle();
    const corner = { x: Math.max(imagesBefore[0].x + imagesBefore[0].w, imagesBefore[1].x + imagesBefore[1].w),
      y: Math.max(imagesBefore[0].y + imagesBefore[0].h, imagesBefore[1].y + imagesBefore[1].h) };
    down(corner.x, corner.y);
    const opened = d.getInteraction();
    for (let i = 1; i <= 6; i += 1) move(corner.x + i * 15, corner.y + i * 11);
    up(corner.x + 90, corner.y + 66);
    await settle();

    const imagesAfter = d.getImages().map(im => ({ x: im.x, y: im.y, w: im.width, h: im.height }));
    const after = d.getNotes()[0];
    const factor = imagesAfter[0].h / imagesBefore[0].h;
    const anchor = { x: imagesBefore[0].x, y: imagesBefore[0].y };
    const expected = { x: anchor.x + (before.pos.x - anchor.x) * factor, fontSize: before.fontSize * factor };
    const squared = { x: anchor.x + (before.pos.x - anchor.x) * factor * factor };
    return { opened, before, after: { pos: after.pos, fontSize: after.fontSize }, factor, expected, squared, dualClaim };
  })()`);
  check(group9b.dualClaim.boxInA && group9b.dualClaim.leaderInB,
    `the fixture is not a genuine dual claim (box centre in A: ${group9b.dualClaim.boxInA}, leader tip in B: ${group9b.dualClaim.leaderInB}) — the next checks would not exercise the bug`);
  check(group9b.opened && group9b.opened.type === 'drag-images-resize',
    `the group-resize fixture did not open a group resize: ${JSON.stringify(group9b.opened)}`);
  check(Math.abs(group9b.factor - 1) > 0.05,
    `the fixture barely resized (factor ${group9b.factor}) — the next checks would be inconclusive`);
  check(Math.abs(group9b.after.pos.x - group9b.expected.x) < 1.5,
    `the note scaled by the wrong amount: expected x ${group9b.expected.x.toFixed(1)} (single factor ${group9b.factor.toFixed(3)}), got ${group9b.after.pos.x.toFixed(1)} (squared prediction ${group9b.squared.x.toFixed(1)})`);
  check(Math.abs(group9b.after.fontSize - group9b.expected.fontSize) < 0.3,
    `the note's font scaled by the wrong amount: expected ${group9b.expected.fontSize.toFixed(2)}, got ${group9b.after.fontSize.toFixed(2)}`);
  check(Math.abs(group9b.after.pos.x - group9b.squared.x) > 5,
    'the note scaled by roughly the SQUARE of the intended factor — the group-resize double-scale bug is back');
  console.log(`notes-check: a group resize scales a cross-photo note by the intended factor exactly once (${group9b.factor.toFixed(3)}x), not its square`);

  // ---- 9c. Double-click is locked in Auto Mode, matching single-click -----
  // onDoubleClick had no state.appMode check at all, so a genuine double-click
  // bypassed the Auto-Mode note lock onMouseDown's Auto branch already
  // enforced for single clicks — it could open the live editor over a
  // read-only Auto Mode board, and an empty commit from there deleted the
  // note even though deleteSelected() explicitly refuses to while
  // state.appMode is 'auto'.
  const auto9c = await s.eval(`(async () => {
    const { d, settle, solidImage, down, up, dblclick, typeInto, commitEditor } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { document.getElementById('autoResetBoardBtn').click(); await settle(); }
    finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 120));
    await d.addBoardImages([solidImage('#f2f2f2', 400, 300)]);
    document.getElementById('modeManualBtn').click(); await settle();
    document.getElementById('toolText').click(); await settle();
    const img = d.getImages()[0];
    down(img.x + 60, img.y + 60); up(img.x + 60, img.y + 60); await settle();
    typeInto(document.getElementById('noteEditor'), 'auto lock check');
    await commitEditor();
    document.getElementById('toolSelect').click(); await settle();
    const note = d.getNotes()[0];
    document.getElementById('modeAutoBtn').click(); await settle();
    const before = { notes: d.getNotes().length, editorOpen: !!d.getNoteEditor() };
    await dblclick(note.pos.x + 15, note.pos.y + 10);
    const afterDbl = { editorOpen: !!d.getNoteEditor(), selection: d.getState().selection };
    if (afterDbl.editorOpen) {
      typeInto(document.getElementById('noteEditor'), '');
      await commitEditor();
    }
    const afterEmptyAttempt = { notes: d.getNotes().length };
    document.getElementById('modeManualBtn').click(); await settle();
    return { before, afterDbl, afterEmptyAttempt, backInManual: { notes: d.getNotes().length } };
  })()`);
  check(auto9c.before.notes === 1 && !auto9c.before.editorOpen,
    'the 9c fixture did not start with one note and a closed editor');
  check(auto9c.afterDbl.editorOpen === false,
    `a double-click opened the note editor in Auto Mode: ${JSON.stringify(auto9c.afterDbl)}`);
  check(auto9c.afterDbl.selection.kind !== 'note',
    `a double-click in Auto Mode selected a note: ${JSON.stringify(auto9c.afterDbl.selection)}`);
  check(auto9c.afterEmptyAttempt.notes === 1,
    `the note was removable through a double-click in Auto Mode: ${auto9c.before.notes} -> ${auto9c.afterEmptyAttempt.notes}`);
  check(auto9c.backInManual.notes === 1, 'the note did not survive the round trip back to Manual Mode');
  console.log('notes-check: double-click is locked to Manual Mode, matching single-click');

  // ---- 9d. Selection chrome is HIDDEN, not frozen, while a note is edited -
  // The dashed selection outline and both leader-handle kinds are derived
  // from noteBounds(note), which reads note.text — a field only ever written
  // on COMMIT. Typing in the textarea never repaints the canvas, so this
  // chrome used to sit frozen at the PRE-EDIT box while the textarea grew or
  // shrank under it: a stale outline, and handles left floating detached
  // (note shrank) or buried under the textarea (note grew) — and unclickable
  // either way, since any mousedown while the editor is open commits and
  // returns before any hit-test runs. Section 8f already proves the ARROWS
  // survive editing; this proves the SELECTION CHROME does not merely
  // survive but is suppressed, measured as zero select-coloured pixels at the
  // pre-edit handle position after the text has grown well past it.
  const editChrome9d = await s.eval(`(async () => {
    const { d, settle, dblclick, sample } = window.__NC;
    const note = d.getNotes()[0];
    await dblclick(note.pos.x + 15, note.pos.y + 10);
    const editing = !!d.getNoteEditor();
    const h0 = d.getNoteHandles(note.id);
    const box = document.getElementById('noteEditor');
    box.value = 'line one\\nline two\\nline three\\nline four\\nline five\\nline six';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    const h1 = d.getNoteHandles(note.id);
    const s0 = sample({ x: h0.add.x - 2, y: h0.add.y - 2, width: 4, height: 4 });
    let selectPx = 0;
    if (!s0.offscreen) {
      for (let i = 0; i < s0.data.length; i += 4) {
        if (Math.abs(s0.data[i] - 0x35) <= 6 && Math.abs(s0.data[i + 1] - 0x6d) <= 6 && Math.abs(s0.data[i + 2] - 0xff) <= 6) selectPx += 1;
      }
    }
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    return { editing, sameBoxWhileEditing: JSON.stringify(h0) === JSON.stringify(h1), selectPx, offscreen: s0.offscreen };
  })()`);
  check(editChrome9d.editing === true, 'the note did not open for editing — the next checks would be vacuous');
  check(editChrome9d.offscreen === false, 'the sample region fell outside the canvas');
  check(editChrome9d.selectPx === 0,
    `selection chrome is still painted at the pre-edit handle position while typing: ${editChrome9d.selectPx} select-coloured px`);
  console.log('notes-check: selection chrome is hidden (not frozen) while a note is being edited');

  // ========================================================================
  // 10. The note's own size control (change request, 2026-08-20). Before this,
  //     a note's fontSize could only change via a photo resize; the TD asked
  //     for a dedicated chip, mirroring #lineWidthChip but never sharing it —
  //     "how thick" and "how big the text is" are different questions with
  //     different units (line width is a stroke weight; a note's stored
  //     fontSize is world px derived from a SCREEN-constant size at creation,
  //     src/ui/note-editor.js's newNoteWorldFontSize).
  // ========================================================================

  // ---- 10a. Visibility: Text tool or a selected NOTE shows the chip; a
  //           selected LINE does not (mutual exclusivity, single-kind
  //           selection) ------------------------------------------------------
  const visibility10a = await s.eval(`(async () => {
    const { d, settle, solidImage, down, up, typeInto, commitEditor } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { document.getElementById('autoResetBoardBtn').click(); await settle(); }
    finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 120));
    await d.addBoardImages([solidImage('#f2f2f2', 500, 360)]);
    document.getElementById('modeManualBtn').click(); await settle();
    const img = d.getImages()[0];
    const chip = document.getElementById('fontSizeChip');
    const lineChip = document.getElementById('lineWidthChip');

    document.getElementById('toolSelect').click(); await settle();
    const nothingSelected = { fontHidden: chip.hidden, lineHidden: lineChip.hidden };

    document.getElementById('toolText').click(); await settle();
    const textToolActive = { fontHidden: chip.hidden };

    down(img.x + 40, img.y + 40); up(img.x + 40, img.y + 40); await settle();
    typeInto(document.getElementById('noteEditor'), 'sized note');
    await commitEditor();
    const note = d.getNotes()[0];
    const afterCommit = { fontHidden: chip.hidden, selection: d.getState().selection };

    document.getElementById('toolStraight').click(); await settle();
    down(img.x + 150, img.y + 150); up(img.x + 150, img.y + 150); await settle();
    down(img.x + 250, img.y + 150); up(img.x + 250, img.y + 150); await settle();
    const lineSelected = { fontHidden: chip.hidden, lineHidden: lineChip.hidden, selection: d.getState().selection };

    document.getElementById('toolSelect').click(); await settle();
    down(note.pos.x + 10, note.pos.y + 6); up(note.pos.x + 10, note.pos.y + 6); await settle();
    const noteSelected = { fontHidden: chip.hidden, selection: d.getState().selection };

    return { nothingSelected, textToolActive, afterCommit, lineSelected, noteSelected, noteId: note.id };
  })()`);
  check(visibility10a.nothingSelected.fontHidden === true,
    'the size chip is visible with nothing selected and the Select tool active');
  check(visibility10a.nothingSelected.lineHidden === false,
    'the pre-existing Line chip vanished — visibility wiring for the new chip broke a sibling control');
  check(visibility10a.textToolActive.fontHidden === false,
    'the size chip stayed hidden with the Text tool active');
  check(visibility10a.afterCommit.selection.kind === 'note' && visibility10a.afterCommit.fontHidden === false,
    `the size chip is not visible right after committing a new note: ${JSON.stringify(visibility10a.afterCommit)}`);
  check(visibility10a.lineSelected.selection.kind === 'annotation',
    'the fixture line was not selected — the mutual-exclusivity check below would be vacuous');
  check(visibility10a.lineSelected.fontHidden === true,
    'the size chip stayed visible while a LINE (not a note) was selected');
  check(visibility10a.lineSelected.lineHidden === false,
    'the Line chip hid itself for a selected line, which is backwards');
  check(visibility10a.noteSelected.selection.kind === 'note' && visibility10a.noteSelected.fontHidden === false,
    `re-selecting the note did not bring the size chip back: ${JSON.stringify(visibility10a.noteSelected)}`);
  console.log('notes-check: the size chip shows for the Text tool or a selected note, never for a selected line');

  // ---- 10b. Editing the chip resizes the SELECTED note, one history step,
  //           and the painted box actually grows ---------------------------
  const resize10b = await s.eval(`(async () => {
    const { d, settle, typeInto } = window.__NC;
    const id = ${visibility10a.afterCommit.selection.id};
    const before = { fontSize: d.getNotes().find(n => n.id === id).fontSize, box: d.getNoteHandles(id).box };
    const input = document.getElementById('fontSizeInput');
    typeInto(input, '90');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const after = { fontSize: d.getNotes().find(n => n.id === id).fontSize, box: d.getNoteHandles(id).box };
    document.getElementById('undoBtn').click();
    await settle();
    const restored = { fontSize: d.getNotes().find(n => n.id === id).fontSize };
    return { before, after, restored, lineWidthUnchanged: document.getElementById('lineWidthInput').value };
  })()`);
  check(resize10b.after.fontSize === 90,
    `the chip did not write the selected note's fontSize: ${resize10b.before.fontSize} -> ${resize10b.after.fontSize}`);
  check(resize10b.after.box.height > resize10b.before.box.height * 1.5,
    `the note's painted box did not grow with its font size: ${resize10b.before.box.height} -> ${resize10b.after.box.height}`);
  check(resize10b.restored.fontSize === resize10b.before.fontSize,
    `Undo did not restore the note's original size: expected ${resize10b.before.fontSize}, got ${resize10b.restored.fontSize}`);
  console.log(`notes-check: the size chip resizes the selected note (${resize10b.before.fontSize} -> ${resize10b.after.fontSize}px, box ${resize10b.before.box.height.toFixed(1)} -> ${resize10b.after.box.height.toFixed(1)}px), one Undo step`);

  // ---- 10c. With nothing selected, the chip sets the STICKY default a NEW
  //           note is born at — mirrors #lineWidthInput's own "next line"
  //           default (setLineWidth always writes state.lineWidth). A new
  //           note's STORED fontSize is world px compensated for the CURRENT
  //           zoom (newNoteWorldFontSize, so it reads as a constant size on
  //           SCREEN whatever the zoom) — the chip's "33" is that screen
  //           target, so the field the note actually carries is 33 / zoom,
  //           not 33 itself. Asserting a literal 33 here would be exactly the
  //           "pos + boxWidth" mistake section 8 warns against, one unit over.
  const sticky10c = await s.eval(`(async () => {
    const { d, settle, down, up, typeInto, commitEditor } = window.__NC;
    document.getElementById('toolSelect').click(); await settle();
    const input = document.getElementById('fontSizeInput');
    document.getElementById('toolText').click(); await settle();
    typeInto(input, '33');
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const zoom = d.getView().zoom;
    const img = d.getImages()[0];
    down(img.x + 40, img.y + 250); up(img.x + 40, img.y + 250); await settle();
    typeInto(document.getElementById('noteEditor'), 'second note');
    await commitEditor();
    const notes = d.getNotes();
    const savedNoteFontSize = d.exportProject().state.noteFontSize;
    return { newNote: notes[notes.length - 1], noteCount: notes.length, savedNoteFontSize, zoom };
  })()`);
  check(sticky10c.noteCount === 2, `the second note was not created: ${sticky10c.noteCount} notes on the board`);
  const expectedWorldFontSize10c = 33 / sticky10c.zoom;
  check(Math.abs(sticky10c.newNote.fontSize - expectedWorldFontSize10c) < 0.05,
    `a new note was not born at the chip's sticky default converted for zoom: expected ~${expectedWorldFontSize10c.toFixed(3)} world px (33 screen px / ${sticky10c.zoom.toFixed(3)} zoom), got ${sticky10c.newNote.fontSize}`);
  check(sticky10c.savedNoteFontSize === 33,
    `the sticky SCREEN-px default did not round-trip into the project snapshot: ${sticky10c.savedNoteFontSize}`);
  console.log(`notes-check: with nothing selected, the chip sets the SCREEN-px default the NEXT note is born at (33 -> ${sticky10c.newNote.fontSize.toFixed(2)} world px at zoom ${sticky10c.zoom.toFixed(2)}), and the screen-px preference saves with the project`);

  // ========================================================================
  // 11. US-100 — Text-only/Box appearance, independent colours and a real
  //     width handle. Text-only means transparent exported content, not an
  //     invisible box that still paints or steals pointer hits. Width is the
  //     single adjustable dimension; height follows wrapping.
  // ========================================================================

  const appearance11a = await s.eval(`(async () => {
    const { d, settle, solidImage, meanColor, countColor, click } = window.__NC;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    try { document.getElementById('autoResetBoardBtn').click(); await settle(); }
    finally { window.confirm = realConfirm; }
    await new Promise(r => setTimeout(r, 120));
    await d.addBoardImages([solidImage('#d0d0d0', 720, 460)]);
    document.getElementById('modeManualBtn').click(); await settle();
    const img = d.getImages()[0];
    const pos = { x: img.x + 70, y: img.y + 70 };
    const corner = { x: pos.x + 1, y: pos.y + 1, width: 4, height: 4 };
    const before = meanColor(corner);
    const note = d.addNote(
      'Long binding instruction wraps into more lines when its width becomes narrower for the technical sketch',
      pos,
      {
        textColor: 'black', leaderColor: 'red', appearance: 'text-only',
        widthMode: 'fixed', boxWidth: 300, fontSize: 22,
        leaders: [{ x: pos.x + 280, y: pos.y + 140 }],
      }
    );
    await settle();
    const after = meanColor(corner);
    const painted = {
      black: countColor({ x: pos.x, y: pos.y, width: 300, height: 150 }, [17, 24, 39], 20),
      red: countColor({ x: pos.x, y: pos.y, width: 300, height: 150 }, [230, 57, 57], 20),
    };
    document.getElementById('toolSelect').click(); await settle();
    await click(pos.x + 10, pos.y + 10);
    const menu = document.getElementById('noteStyleMenuWrap');
    const lineSettings = document.querySelector('.board-line-settings');
    const activeAppearance = document.getElementById('noteAppearanceTextOnlyBtn').classList.contains('active');
    const fields = d.getNotes().find(n => n.id === note.id);
    return {
      id: note.id, pos, before, after, painted, fields,
      selection: d.getState().selection,
      noteMenuHidden: menu.hidden,
      lineMenuHidden: lineSettings.hidden,
      activeAppearance,
      trigger: document.getElementById('noteStyleMenuBtn').textContent,
    };
  })()`);
  check(Math.abs(appearance11a.after.r - appearance11a.before.r) < 1
      && Math.abs(appearance11a.after.g - appearance11a.before.g) < 1
      && Math.abs(appearance11a.after.b - appearance11a.before.b) < 1,
    `Text-only painted a fill/border over the sketch: before ${JSON.stringify(appearance11a.before)}, after ${JSON.stringify(appearance11a.after)}`);
  check(appearance11a.painted.black.count > 35,
    `the default black text did not paint enough glyph pixels: ${appearance11a.painted.black.count}`);
  check(appearance11a.painted.red.count > 20,
    `the default red leader did not paint enough pixels: ${appearance11a.painted.red.count}`);
  check(appearance11a.fields.appearance === 'text-only'
      && appearance11a.fields.textColor === 'black'
      && appearance11a.fields.leaderColor === 'red'
      && appearance11a.fields.widthMode === 'fixed',
    `the new note fields are not the US-100 defaults: ${JSON.stringify(appearance11a.fields)}`);
  check(appearance11a.selection.kind === 'note' && appearance11a.selection.id === appearance11a.id,
    `clicking visible Text-only content did not select the note: ${JSON.stringify(appearance11a.selection)}`);
  check(appearance11a.noteMenuHidden === false && appearance11a.lineMenuHidden === true,
    `the contextual controls are wrong for a selected note: note hidden=${appearance11a.noteMenuHidden}, line hidden=${appearance11a.lineMenuHidden}`);
  check(appearance11a.activeAppearance === true && /Text only/.test(appearance11a.trigger),
    `the Note menu did not reflect Text-only: ${appearance11a.trigger}`);
  console.log('notes-check: Text-only is truly transparent, with black text and a red leader in its own contextual menu');

  const box11b = await s.eval(`(async () => {
    const { d, settle, meanColor } = window.__NC;
    const id = ${appearance11a.id};
    const pos = ${JSON.stringify(appearance11a.pos)};
    const corner = { x: pos.x + 1, y: pos.y + 1, width: 4, height: 4 };
    d.setNoteAppearance('box'); await settle();
    const boxed = {
      note: d.getNotes().find(n => n.id === id),
      ground: meanColor(corner),
    };
    document.getElementById('undoBtn').click(); await settle();
    const undone = d.getNotes().find(n => n.id === id);
    document.getElementById('redoBtn').click(); await settle();
    const redone = d.getNotes().find(n => n.id === id);
    d.setNoteAppearance('text-only'); await settle();
    return { boxed, undone, redone, final: d.getNotes().find(n => n.id === id) };
  })()`);
  check(box11b.boxed.note.appearance === 'box' && box11b.boxed.ground.r > appearance11a.after.r + 20,
    `Box appearance did not paint its light ground: ${JSON.stringify(box11b.boxed)}`);
  check(box11b.undone.appearance === 'text-only' && box11b.redone.appearance === 'box',
    `appearance did not round-trip through Undo/Redo: ${box11b.undone.appearance} -> ${box11b.redone.appearance}`);
  check(box11b.final.appearance === 'text-only', 'the fixture did not return to Text-only after the Box check');
  console.log('notes-check: Box paints a real ground, and appearance is one Undo/Redo step');

  const colors11c = await s.eval(`(async () => {
    const { d, settle, countColor } = window.__NC;
    const id = ${appearance11a.id};
    const pos = ${JSON.stringify(appearance11a.pos)};
    d.setNoteTextColor('blue');
    d.setNoteLeaderColor('red');
    await settle();
    const beforeLineColor = d.getNotes().find(n => n.id === id);
    document.getElementById('colorBlackBtn').click(); await settle();
    const afterLineColor = d.getNotes().find(n => n.id === id);
    return {
      beforeLineColor, afterLineColor,
      blue: countColor({ x: pos.x, y: pos.y, width: 300, height: 150 }, [37, 99, 235], 20),
      red: countColor({ x: pos.x, y: pos.y, width: 300, height: 150 }, [230, 57, 57], 20),
    };
  })()`);
  check(colors11c.beforeLineColor.textColor === 'blue' && colors11c.beforeLineColor.leaderColor === 'red',
    `text/leader colours did not stay independent: ${JSON.stringify(colors11c.beforeLineColor)}`);
  check(colors11c.afterLineColor.textColor === 'blue' && colors11c.afterLineColor.leaderColor === 'red',
    `the line-colour control leaked into the selected note: ${JSON.stringify(colors11c.afterLineColor)}`);
  check(colors11c.blue.count > 35 && colors11c.red.count > 20,
    `independent blue text/red leader pixels were not both present: ${JSON.stringify(colors11c)}`);
  console.log('notes-check: text and leader colours change independently; line colour cannot retint a note');

  const export11c2 = await s.eval(`(async () => {
    const { d, settle } = window.__NC;
    const decode = async () => {
      const im = new Image();
      im.src = d.exportBoardDataUrl();
      await im.decode();
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height).data;
      let gray = 0, blue = 0, red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - 208) <= 2 && Math.abs(data[i+1] - 208) <= 2 && Math.abs(data[i+2] - 208) <= 2) gray += 1;
        if (Math.abs(data[i] - 37) <= 20 && Math.abs(data[i+1] - 99) <= 20 && Math.abs(data[i+2] - 235) <= 20) blue += 1;
        if (Math.abs(data[i] - 230) <= 20 && Math.abs(data[i+1] - 57) <= 20 && Math.abs(data[i+2] - 57) <= 20) red += 1;
      }
      return { w: c.width, h: c.height, gray, blue, red };
    };
    const textOnly = await decode();
    d.setNoteAppearance('box'); await settle();
    const box = await decode();
    d.setNoteAppearance('text-only'); await settle();
    return { textOnly, box };
  })()`);
  check(export11c2.textOnly.w === export11c2.box.w && export11c2.textOnly.h === export11c2.box.h,
    `appearance unexpectedly changed the image-owned export frame: ${JSON.stringify(export11c2)}`);
  check(export11c2.textOnly.gray > export11c2.box.gray + 10000,
    `Text-only export still appears to carry a Box ground: gray pixels ${export11c2.textOnly.gray} vs ${export11c2.box.gray}`);
  check(export11c2.textOnly.blue > 35 && export11c2.textOnly.red > 20,
    `the independent blue text/red leader did not reach the exported PNG: ${JSON.stringify(export11c2.textOnly)}`);
  console.log(`notes-check: the exported PNG keeps Text-only transparent (+${export11c2.textOnly.gray - export11c2.box.gray} sketch-ground px versus Box) and carries both colours`);

  const resize11d = await s.eval(`(async () => {
    const { d, settle, drag } = window.__NC;
    const id = ${appearance11a.id};
    const before = d.getNotes().find(n => n.id === id);
    const beforeHandles = d.getNoteHandles(id);
    const interaction = await drag(
      beforeHandles.resize.x, beforeHandles.resize.y,
      beforeHandles.resize.x - 145, beforeHandles.resize.y
    );
    const after = d.getNotes().find(n => n.id === id);
    const afterHandles = d.getNoteHandles(id);
    document.getElementById('undoBtn').click(); await settle();
    const undone = d.getNotes().find(n => n.id === id);
    document.getElementById('redoBtn').click(); await settle();
    const redone = d.getNotes().find(n => n.id === id);
    return { before, beforeHandles, interaction, after, afterHandles, undone, redone };
  })()`);
  check(resize11d.interaction && resize11d.interaction.type === 'drag-note-resize',
    `the right-edge handle started the wrong interaction: ${JSON.stringify(resize11d.interaction)}`);
  check(resize11d.after.boxWidth < resize11d.before.boxWidth - 100,
    `the width handle did not narrow the note: ${resize11d.before.boxWidth} -> ${resize11d.after.boxWidth}`);
  check(resize11d.afterHandles.box.height > resize11d.beforeHandles.box.height,
    `height did not auto-grow after narrower wrapping: ${resize11d.beforeHandles.box.height} -> ${resize11d.afterHandles.box.height}`);
  check(resize11d.after.pos.x === resize11d.before.pos.x && resize11d.after.pos.y === resize11d.before.pos.y
      && resize11d.after.fontSize === resize11d.before.fontSize
      && JSON.stringify(resize11d.after.leaders) === JSON.stringify(resize11d.before.leaders),
    `width resize moved or restyled unrelated note content: ${JSON.stringify({ before: resize11d.before, after: resize11d.after })}`);
  check(Math.hypot(
      resize11d.afterHandles.add.x - resize11d.afterHandles.resize.x,
      resize11d.afterHandles.add.y - resize11d.afterHandles.resize.y
    ) > 12,
    'the width handle overlapped the lower-right + Add Leader handle');
  check(Math.abs(resize11d.undone.boxWidth - resize11d.before.boxWidth) < 0.001
      && Math.abs(resize11d.redone.boxWidth - resize11d.after.boxWidth) < 0.001,
    `resize did not round-trip through Undo/Redo: ${resize11d.before.boxWidth}/${resize11d.after.boxWidth}/${resize11d.undone.boxWidth}/${resize11d.redone.boxWidth}`);
  console.log(`notes-check: right-edge resize narrows width ${resize11d.before.boxWidth.toFixed(1)} -> ${resize11d.after.boxWidth.toFixed(1)} and wrapping auto-grows height ${resize11d.beforeHandles.box.height.toFixed(1)} -> ${resize11d.afterHandles.box.height.toFixed(1)}`);

  const persistence11e = await s.eval(`(async () => {
    const { d, settle } = window.__NC;
    const id = ${appearance11a.id};
    const snapshot = d.exportProject();
    const expected = d.getNotes().find(n => n.id === id);
    await d.loadProject(snapshot); await settle();
    const reopened = d.getNotes().find(n => n.id === id);
    const legacy = d.exportProject();
    delete legacy.state.noteAppearance;
    delete legacy.state.noteTextColor;
    delete legacy.state.noteLeaderColor;
    legacy.state.notes = [{
      id: 99100,
      text: 'legacy boxed note',
      pos: { x: reopened.pos.x, y: reopened.pos.y + 210 },
      color: 'blue', fontSize: 18, boxWidth: 220,
      leaders: [{ x: reopened.pos.x + 300, y: reopened.pos.y + 250 }],
    }];
    await d.loadProject(legacy); await settle();
    return {
      expected, reopened,
      legacy: d.getNotes()[0],
      sticky: {
        appearance: d.exportProject().state.noteAppearance,
        textColor: d.exportProject().state.noteTextColor,
        leaderColor: d.exportProject().state.noteLeaderColor,
      },
    };
  })()`);
  check(persistence11e.reopened.appearance === persistence11e.expected.appearance
      && persistence11e.reopened.textColor === persistence11e.expected.textColor
      && persistence11e.reopened.leaderColor === persistence11e.expected.leaderColor
      && Math.abs(persistence11e.reopened.boxWidth - persistence11e.expected.boxWidth) < 0.001,
    `new note fields did not survive project reopen: ${JSON.stringify(persistence11e)}`);
  check(persistence11e.legacy.appearance === 'box'
      && persistence11e.legacy.textColor === 'blue'
      && persistence11e.legacy.leaderColor === 'blue'
      && persistence11e.legacy.widthMode === 'content',
    `a pre-US-100 note did not migrate to its old boxed, one-colour pixels: ${JSON.stringify(persistence11e.legacy)}`);
  check(persistence11e.sticky.appearance === 'text-only'
      && persistence11e.sticky.textColor === 'black'
      && persistence11e.sticky.leaderColor === 'red',
    `a legacy project did not receive the new sticky defaults: ${JSON.stringify(persistence11e.sticky)}`);
  console.log('notes-check: resized notes reopen exactly; legacy notes reopen boxed with their original shared colour');

  const errors = await s.eval(`window.__ncConsoleErrors || []`);
  check(errors.length === 0, `page errors during the run: ${JSON.stringify(errors)}`);

  s.close();
  console.log(`notes-check: PASS (${passed} checks)`);
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
  await cdp('Runtime.evaluate', { expression: `window.__ncConsoleErrors=[]; addEventListener('error',e=>window.__ncConsoleErrors.push(String(e.message||e.error)))` });
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
