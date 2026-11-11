#!/usr/bin/env node
// US-094: browser-level contract for the command registry, Command Palette,
// scoped shortcuts, and keyboard-only access across all five tech-pack pages.
// Section 9 pins the keys whose duplicate legacy-router branch was deleted:
// they must act, and refuse, through the registry alone (incl. the N fix).
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

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'keyboard-shortcuts-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1366,900', `${started.baseUrl}/index.html?keyboard=${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`window.__braAutoModeDebug && document.querySelectorAll('#pageTabBar [role="tab"]').length === 5`, 8000);

  // 1. Registry shape: broad inventory, unique ids, all five page scopes.
  const inventory = await s.eval(`(() => {
    const commands = window.__braAutoModeDebug.commands.list();
    const ids = commands.map(command => command.id);
    return {
      count: commands.length,
      unique: new Set(ids).size,
      pages: Array.from(new Set(commands.map(command => command.page).filter(Boolean))).sort(),
      required: ['palette.open','page.board','page.mainpage','page.construction','page.bom','page.preview',
        'board.auto.detect','board.tool.curved','main.print','construction.row.add-outer',
        'bom.row.add-fabric','preview.export'].every(id => ids.includes(id)),
      paletteShortcut: commands.find(command => command.id === 'palette.open').shortcut,
    };
  })()`);
  check(inventory.count >= 80, `expected at least 80 stable commands, got ${inventory.count}`);
  check(inventory.unique === inventory.count, `command ids must be unique (${inventory.unique}/${inventory.count})`);
  check(inventory.pages.join(',') === 'board,bom,construction,mainpage,preview',
    `registry page scopes wrong: ${inventory.pages.join(',')}`);
  check(inventory.required, 'registry is missing one or more required cross-page commands');
  check(/K$/.test(inventory.paletteShortcut), `palette shortcut should end in K, got ${inventory.paletteShortcut}`);

  // 2. Cmd/Ctrl+K opens a real modal, focuses search, and lists every command.
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'k', ctrlKey:true, bubbles:true }))`);
  await s.waitFor(`document.querySelector('.command-palette-overlay')`, 3000);
  const palette = await s.eval(`({
    role: document.querySelector('.command-palette-panel').getAttribute('role'),
    modal: document.querySelector('.command-palette-panel').getAttribute('aria-modal'),
    focus: document.activeElement.className,
    rows: document.querySelectorAll('.command-palette-row').length,
  })`);
  check(palette.role === 'dialog' && palette.modal === 'true', 'Command Palette must expose a modal dialog');
  check(palette.focus === 'command-palette-search', `palette search should own focus, got ${palette.focus}`);
  check(palette.rows === inventory.count, `palette should render all ${inventory.count} commands, got ${palette.rows}`);

  // Disabled cross-page commands stay visible and explain their page.
  const disabled = await s.eval(`(() => {
    const q = document.querySelector('.command-palette-search');
    q.value = 'Add BOM Fabric Row';
    q.dispatchEvent(new Event('input', { bubbles:true }));
    const row = document.querySelector('.command-palette-row');
    q.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
    return { disabled: row.getAttribute('aria-disabled'), text: row.textContent,
      stillOpen: !!document.querySelector('.command-palette-overlay') };
  })()`);
  check(disabled.disabled === 'true', 'a BOM command must be disabled while Board is active');
  check(disabled.text.includes('Available on BOM'), `disabled command needs a reason, got ${disabled.text}`);
  check(disabled.stillOpen, 'Enter on a disabled command must keep the palette open');

  // Escape closes and restores focus to the invoking element.
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  await s.waitFor(`!document.querySelector('.command-palette-overlay')`, 2000);
  check(await s.eval(`document.activeElement === document.body`), 'closing the palette should restore its invoking focus');

  // 3. Global page chords work even from a focused field, committing blur.
  const nav = await s.eval(`(() => {
    const input = document.getElementById('styleIdInput');
    input.focus();
    input.value = 'KB-SCOPE';
    input.dispatchEvent(new Event('input', { bubbles:true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key:'2', ctrlKey:true, bubbles:true }));
    return { page: window.__braAutoModeDebug.getState().activePage,
      blurred: document.activeElement !== input,
      style: window.__braAutoModeDebug.exportProject().state.styleId };
  })()`);
  check(nav.page === 'mainpage', `Ctrl+2 should open Main Page, got ${nav.page}`);
  check(nav.blurred, 'global page navigation should commit and blur a focused field');
  check(nav.style === 'KB-SCOPE', `focused field did not commit before navigation: ${nav.style}`);

  // Plain Board letters never act on a hidden Board.
  const scoped = await s.eval(`(() => {
    window.__boardAddClicks = 0;
    document.getElementById('addImageBtn').addEventListener('click', () => { window.__boardAddClicks += 1; });
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'a', bubbles:true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'d', bubbles:true }));
    return { page: window.__braAutoModeDebug.getState().activePage, clicks: window.__boardAddClicks };
  })()`);
  check(scoped.page === 'mainpage', 'plain Board shortcuts must not switch or mutate another page');
  check(scoped.clicks === 0, 'plain A on Main Page must not open the hidden Board image picker');

  // 4. Page tablists implement roving keyboard navigation and activation.
  const tabNav = await s.eval(`(() => {
    const tab = document.querySelector('#pageTabBar [data-page="mainpage"]');
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));
    return { page: window.__braAutoModeDebug.getState().activePage,
      focus: document.activeElement.dataset.page,
      tabStops: Array.from(document.querySelectorAll('#pageTabBar [role="tab"]')).filter(x => x.tabIndex === 0).length };
  })()`);
  check(tabNav.page === 'construction' && tabNav.focus === 'construction',
    `ArrowRight should focus and activate Construction, got ${JSON.stringify(tabNav)}`);
  check(tabNav.tabStops === 1, `page tablist must keep one tab stop, got ${tabNav.tabStops}`);

  // Construction and BOM variants use the same arrow-key tab behavior.
  const constructionTabs = await s.eval(`(() => {
    const solid = document.querySelector('[data-cc-sheet="solid"]');
    solid.focus();
    solid.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));
    return { focus: document.activeElement.dataset.ccSheet,
      lace: document.querySelector('[data-cc-sheet="lace"]').getAttribute('aria-pressed') };
  })()`);
  check(constructionTabs.focus === 'lace' && constructionTabs.lace === 'true',
    `Construction sheet tabs did not keyboard-switch: ${JSON.stringify(constructionTabs)}`);

  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'4', ctrlKey:true, bubbles:true }))`);
  const bomTabs = await s.eval(`(() => {
    const solid = document.querySelector('[data-bom-variant="solid"]');
    solid.focus();
    solid.dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true }));
    return { page: window.__braAutoModeDebug.getState().activePage,
      focus: document.activeElement.dataset.bomVariant,
      lace: document.querySelector('[data-bom-variant="lace"]').getAttribute('aria-pressed') };
  })()`);
  check(bomTabs.page === 'bom' && bomTabs.focus === 'lace' && bomTabs.lace === 'true',
    `BOM variant tabs did not keyboard-switch: ${JSON.stringify(bomTabs)}`);

  // 5. Palette executes a stable command on its owning page.
  const beforeRows = await s.eval(`window.__braAutoModeDebug.exportProject().state.bom.rows.length`);
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'k', ctrlKey:true, bubbles:true }))`);
  await s.waitFor(`document.querySelector('.command-palette-search')`, 2000);
  await s.eval(`(() => {
    const q = document.querySelector('.command-palette-search');
    q.value = 'Add BOM Fabric Row';
    q.dispatchEvent(new Event('input', { bubbles:true }));
    q.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
  })()`);
  await s.waitFor(`!document.querySelector('.command-palette-overlay')`, 2000);
  const afterRows = await s.eval(`window.__braAutoModeDebug.exportProject().state.bom.rows.length`);
  check(afterRows === beforeRows + 1, `palette should add exactly one BOM row (${beforeRows} -> ${afterRows})`);

  // Escape closes the modal without leaking into page-level Escape handlers.
  // Main Page, Construction, and BOM otherwise interpret a second Escape as
  // "return to Board", which must not happen for the palette's own Escape.
  const retainedPages = await s.eval(`(() => {
    const result = {};
    [['2','mainpage'], ['3','construction'], ['4','bom'], ['5','preview']].forEach(([key, page]) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey:true, bubbles:true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'k', ctrlKey:true, bubbles:true }));
      document.querySelector('.command-palette-search').dispatchEvent(
        new KeyboardEvent('keydown', { key:'Escape', bubbles:true })
      );
      result[page] = window.__braAutoModeDebug.getState().activePage;
    });
    return result;
  })()`);
  check(Object.entries(retainedPages).every(([page, active]) => page === active),
    `palette Escape leaked into page navigation: ${JSON.stringify(retainedPages)}`);

  // 6. Fixed repeated controls remain natively keyboard reachable.
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'2', ctrlKey:true, bubbles:true }))`);
  const mainKeyboard = await s.eval(`({
    slots: Array.from(document.querySelectorAll('#mainPageOverlay [data-mp-sk]')).every(x => x.tabIndex === 0 && x.getAttribute('role') === 'button'),
    count: document.querySelectorAll('#mainPageOverlay [data-mp-sk]').length,
  })`);
  check(mainKeyboard.count === 4 && mainKeyboard.slots, 'all four Main Page sketch slots must be keyboard buttons');
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'4', ctrlKey:true, bubbles:true }))`);
  const bomKeyboard = await s.eval(`({
    suggestions: document.querySelectorAll('[data-bom-dd]').length,
    tabbable: Array.from(document.querySelectorAll('[data-bom-dd]')).every(x => x.tabIndex === 0),
  })`);
  check(bomKeyboard.suggestions > 0 && bomKeyboard.tabbable,
    'every BOM suggestion button must be in the keyboard tab order');

  // 7. Preview sheet toggles and export are present in the registry/palette.
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'5', ctrlKey:true, bubbles:true }))`);
  const preview = await s.eval(`(() => {
    const api = window.__braAutoModeDebug;
    const commands = api.commands.list();
    const toggles = commands.filter(command => command.id.startsWith('preview.sheet.'));
    const box = document.querySelector('[data-pv-toggle="mainpage"]');
    const before = box.checked;
    api.commands.run('preview.sheet.mainpage');
    return { page: api.getState().activePage, toggles: toggles.length,
      changed: box.checked !== before, exportEnabled: commands.find(x => x.id === 'preview.export').availability.enabled };
  })()`);
  check(preview.page === 'preview' && preview.toggles === 6,
    `Preview should expose six fixed sheet commands, got ${JSON.stringify(preview)}`);
  check(preview.changed, 'running a Preview sheet command must toggle its checkbox');
  check(preview.exportEnabled, 'Preview export should remain available with five sheets enabled');

  // 8. Existing Board direct shortcuts stay intact, Help is registry-backed.
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'1', ctrlKey:true, bubbles:true }));
    document.getElementById('modeManualBtn').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'c', bubbles:true }));`);
  check(await s.eval(`window.__braAutoModeDebug.getState().tool === 'curved'`),
    'existing C shortcut must still activate the Curved tool on Manual Board');
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'?', shiftKey:true, bubbles:true }))`);
  await s.waitFor(`document.querySelector('.dialog-panel') && /Help/.test(document.querySelector('.dialog-panel h2').textContent)`, 2000);
  const help = await s.eval(`({
    hasPalette: document.querySelector('.dialog-body').textContent.includes('Open Command Palette'),
    hasPages: document.querySelector('.dialog-body').textContent.includes('Go to Preview & Export'),
    hasCurved: document.querySelector('.dialog-body').textContent.includes('Curved Line Tool'),
  })`);
  check(help.hasPalette && help.hasPages && help.hasCurved,
    `Help must render registry-backed global and Board shortcuts: ${JSON.stringify(help)}`);
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);

  // Directly hinted controls expose both visible and assistive shortcut data.
  const hints = await s.eval(`({
    addKey: document.getElementById('addImageBtn').dataset.key,
    addAria: document.getElementById('addImageBtn').getAttribute('aria-keyshortcuts'),
    saveTitle: document.getElementById('saveProjectBtn').title,
  })`);
  check(hints.addKey === 'A' && hints.addAria === 'a', `Add Image hint metadata wrong: ${JSON.stringify(hints)}`);
  check(/Shortcut:/.test(hints.saveTitle), `Save tooltip needs its registry shortcut: ${hints.saveTitle}`);

  // 9. The legacy router's duplicate branches for S, H, G, 0, B/C, T, X, E,
  //    P, I, N, R, D and 1/2/3 were deleted (2026-11-11 dead-code pass): these
  //    keys now run ONLY through their registry command. Prove a sample still
  //    acts on a Manual Board and still refuses where the registry refuses.
  await s.waitFor(`!document.querySelector('.picker-overlay')`, 2000);
  const viaRegistry = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const press = key => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles:true }));
    const out = { mode: d.getState().appMode };
    press('s'); out.s = d.getState().tool;
    press('0'); out.zero = d.getState().tool;
    press('b'); out.b = d.getState().tool;
    press('t'); out.t = d.getState().tool;
    press('s');
    const workspace = document.querySelector('.workspace');
    const hiddenBefore = workspace.classList.contains('panel-hidden');
    press('h'); out.hToggled = workspace.classList.contains('panel-hidden') !== hiddenBefore;
    press('h'); out.hRestored = workspace.classList.contains('panel-hidden') === hiddenBefore;
    press('g');
    const title = document.querySelector('.dialog-panel h2');
    out.grading = !!title && /Grading/i.test(title.textContent);
    return out;
  })()`);
  check(viaRegistry.mode === 'manual', `registry key checks expect Manual Mode, got ${viaRegistry.mode}`);
  check(viaRegistry.s === 'select' && viaRegistry.zero === 'straight' && viaRegistry.b === 'curved' && viaRegistry.t === 'text',
    `S / 0 / B / T must pick their tools through the registry: ${JSON.stringify(viaRegistry)}`);
  check(viaRegistry.hToggled && viaRegistry.hRestored, `H must toggle the Measurements panel: ${JSON.stringify(viaRegistry)}`);
  check(viaRegistry.grading, 'G must open the Grading dialog through the registry');
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  await s.waitFor(`!document.querySelector('.dialog-panel')`, 2000);

  // A refused command stays refused: with no image, X (Eraser) cannot arm,
  // and in Auto Mode the Manual-only 0 / T tools never steal Select.
  const refused = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const press = key => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles:true }));
    const out = { images: d.getState().imageCount };
    press('x'); out.eraser = d.getState().tool;
    document.getElementById('modeAutoBtn').click();
    out.mode = d.getState().appMode;
    press('0'); press('t'); out.autoTool = d.getState().tool;
    document.getElementById('modeManualBtn').click();
    return out;
  })()`);
  check(refused.images === 0 && refused.eraser === 'select', `X must not arm the Eraser on an image-less board: ${JSON.stringify(refused)}`);
  check(refused.mode === 'auto' && refused.autoTool === 'select', `0 / T must stay inert in Auto Mode: ${JSON.stringify(refused)}`);

  // N fix: in Stitch mode #toggleLabelsBtn is disabled, so N must NOT flip the
  // hidden showLabels flag (the deleted legacy branch did, and the numbers
  // came back inverted on leaving Stitch mode). In POM mode N still toggles.
  const labels = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const btn = document.getElementById('toggleLabelsBtn');
    const press = () => document.dispatchEvent(new KeyboardEvent('keydown', { key:'n', bubbles:true }));
    const out = { stitchRan: d.commands.run('board.style.zigzag') };
    out.stitchDisabled = btn.disabled;
    const before = btn.textContent;
    press();
    out.stitchUnchanged = btn.textContent === before;
    out.pomRan = d.commands.run('board.style.solid');
    out.pomEnabled = !btn.disabled;
    const pomBefore = btn.textContent;
    press();
    out.pomToggled = btn.textContent !== pomBefore;
    press();
    out.pomRestored = btn.textContent === pomBefore;
    return out;
  })()`);
  check(labels.stitchRan && labels.stitchDisabled, `Stitch mode must disable Hide/Show Numbers: ${JSON.stringify(labels)}`);
  check(labels.stitchUnchanged, `N in Stitch mode must not toggle the hidden numbers flag: ${JSON.stringify(labels)}`);
  check(labels.pomRan && labels.pomEnabled && labels.pomToggled && labels.pomRestored,
    `N in POM mode must still toggle numbers: ${JSON.stringify(labels)}`);

  await s.close();
  console.log(`PASS  keyboard-shortcuts-check   ${passed}/${passed} assertions ok`);
}

function check(condition, message) {
  if (!condition) {
    console.error('FAIL  ' + message);
    process.exitCode = 1;
    throw new Error(message);
  }
  passed += 1;
}

async function openCdpSession(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return connectToTarget(target.webSocketDebuggerUrl);
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
  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
  if (error && error.message) console.error('FAIL', error.message);
} finally {
  for (const task of cleanupTasks.reverse()) {
    try { await task(); } catch (_) {}
  }
}
