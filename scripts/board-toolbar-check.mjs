#!/usr/bin/env node
// US-082: Browser-level contract for the Contextual Board Toolbar.
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

const VISIBLE_BUTTONS = `Array.from(document.querySelectorAll('#boardToolbarGroups button'))
  .filter(button => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return !button.hidden && style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  }).map(button => button.id)`;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'board-toolbar-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    `${started.baseUrl}/index.html?toolbar=${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const s = await openCdpSession(cdpPort);
  await s.waitFor(`document.querySelectorAll('#specBody tr').length > 0`, 8000);
  console.log('board-toolbar-check: app ready');

  // Empty Auto: mode, add, File, More. Disabled workflow controls do not
  // occupy the primary surface.
  const emptyAuto = await s.eval(`({
    buttons: ${VISIBLE_BUTTONS},
    primary: Array.from(document.querySelectorAll('#boardToolbarGroups button'))
      .filter(b => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0
        && (b.classList.contains('primary-btn') || b.classList.contains('context-primary')))
      .map(b => b.id),
    toolbarHeight: Math.round(document.querySelector('.toolbar').getBoundingClientRect().height),
  })`);
  check(JSON.stringify(emptyAuto.buttons) === JSON.stringify([
    'modeManualBtn', 'modeAutoBtn', 'addImageBtn', 'fileMenuBtn', 'moreMenuBtn',
  ]), `empty Auto controls wrong: ${JSON.stringify(emptyAuto.buttons)}`);
  check(emptyAuto.primary.join(',') === 'addImageBtn', `empty Auto primary should be Add Image, got ${emptyAuto.primary}`);
  check(emptyAuto.toolbarHeight < 115, `empty Auto toolbar should stay within two rows, height ${emptyAuto.toolbarHeight}`);
  console.log('board-toolbar-check: empty Auto ok');

  // Empty Manual: drawing entry points remain direct; line settings,
  // selection actions, and Export stay hidden until Board content exists.
  await s.eval(`document.getElementById('modeManualBtn').click()`);
  const emptyManual = await s.eval(`({
    buttons: ${VISIBLE_BUTTONS},
    contextHidden: document.getElementById('boardContextActions').hidden,
    lineSettingsHidden: document.querySelector('.board-line-settings').hidden,
    exportHidden: document.getElementById('exportMenuWrap').hidden,
    units: Array.from(document.querySelectorAll('#boardToolbarGroups > :not(.toolbar-spacer)'))
      .filter(el => { const r=el.getBoundingClientRect(); return !el.hidden && getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0; }).length,
  })`);
  // The exact SET, not a count. US-092 added a fifth drawing tool and this
  // assertion failed as "9 direct buttons, got 10" — true, but it does not say
  // WHICH control appeared, which is the only thing a reviewer needs to decide
  // whether the change belongs. The Text tool does: a note needs no photo, so
  // it is an authoring entry point exactly like Straight and Curved, and the
  // three claims this section really makes (no line settings, no selection
  // actions, no Export on an empty board) are asserted separately below.
  check(JSON.stringify(emptyManual.buttons) === JSON.stringify([
    'modeManualBtn', 'modeAutoBtn', 'addImageBtn',
    'toolSelect', 'toolStraight', 'toolCurved', 'toolText',
    'stitchesBtn', 'fileMenuBtn', 'moreMenuBtn',
  ]), `empty Manual controls wrong: ${JSON.stringify(emptyManual.buttons)}`);
  check(emptyManual.contextHidden, 'selection actions should be hidden with no selection/history');
  check(emptyManual.lineSettingsHidden, 'line settings should be hidden on an empty Manual Board');
  check(emptyManual.exportHidden, 'Export should be hidden on an empty Manual Board');
  check(emptyManual.units <= 6, `empty Manual should have at most 6 direct toolbar units, got ${emptyManual.units}`);
  console.log('board-toolbar-check: empty Manual ok');

  // Menus are accessible: trigger state, first enabled focus, keyboard
  // traversal, and Escape-to-close/focus-return.
  await s.eval(`document.getElementById('fileMenuBtn').click()`);
  const fileOpen = await s.eval(`({
    open: !document.getElementById('fileMenuList').hidden,
    expanded: document.getElementById('fileMenuBtn').getAttribute('aria-expanded'),
    focus: document.activeElement.id,
  })`);
  check(fileOpen.open && fileOpen.expanded === 'true', 'File menu did not open with aria-expanded=true');
  check(fileOpen.focus === 'addImageMenuBtn', `File menu should focus first enabled item, got ${fileOpen.focus}`);
  await s.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true }))`);
  check(await s.eval(`document.activeElement.id === 'openProjectBtn'`), 'ArrowDown should skip disabled Save and focus Open');
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  const fileClosed = await s.eval(`({ hidden:document.getElementById('fileMenuList').hidden,
    expanded:document.getElementById('fileMenuBtn').getAttribute('aria-expanded'), focus:document.activeElement.id })`);
  check(fileClosed.hidden && fileClosed.expanded === 'false', 'Escape did not close File menu');
  check(fileClosed.focus === 'fileMenuBtn', `Escape should return focus to File trigger, got ${fileClosed.focus}`);
  console.log('board-toolbar-check: menu keyboard ok');

  // Add a real fixture without invoking detection: this isolates the Auto
  // ready-state toolbar. Detection and Apply remain owned by smoke/golden.
  const autoReady = await s.eval(`(async () => {
    document.getElementById('modeAutoBtn').click();
    const blob = await (await fetch('demo/demo1.jpg?toolbar=' + Date.now())).blob();
    const dataURL = await new Promise(resolve => { const rd=new FileReader(); rd.onload=()=>resolve(rd.result); rd.readAsDataURL(blob); });
    const result = await window.__braAutoModeDebug.addBoardImages([dataURL]);
    const visible = ${VISIBLE_BUTTONS};
    const primary = visible.filter(id => document.getElementById(id).classList.contains('context-primary'));
    return { status:result.status, imageCount:result.imageCount, visible, primary };
  })()`);
  check(autoReady.status === 'ready' && autoReady.imageCount === 1,
    `real Board image should reach Auto ready state, got ${JSON.stringify(autoReady)}`);
  check(autoReady.visible.includes('autoDetectBtn') && !autoReady.visible.includes('autoGenerateBtn'),
    'Auto ready should show Detect but not Generate');
  check(autoReady.primary.join(',') === 'autoDetectBtn', `Detect should be the only workflow primary, got ${autoReady.primary}`);
  console.log('board-toolbar-check: Auto ready ok');

  await s.eval(`document.getElementById('modeManualBtn').click()`);
  await s.waitFor(`!document.body.classList.contains('app-auto')`, 4000);
  const populatedManual = await s.eval(`({
    lineSettings: !document.querySelector('.board-line-settings').hidden,
    exportVisible: !document.getElementById('exportMenuWrap').hidden,
    contextHidden: document.getElementById('boardContextActions').hidden,
    contextButtons: Array.from(document.querySelectorAll('#boardContextActions button'))
      .filter(button => !button.hidden && button.getBoundingClientRect().width > 0).map(button => button.id),
    directUnits: Array.from(document.querySelectorAll('#boardToolbarGroups > :not(.toolbar-spacer)'))
      .filter(el => { const r=el.getBoundingClientRect(); return !el.hidden && getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0; }).length,
  })`);
  check(!populatedManual.lineSettings, 'image selection should hide irrelevant line settings');
  check(populatedManual.exportVisible, 'Export menu should return on a populated Manual Board');
  check(!populatedManual.contextHidden && populatedManual.contextButtons.includes('lockImageBtn')
      && populatedManual.contextButtons.includes('deleteBtn')
      && !populatedManual.contextButtons.includes('copyLineBtn'),
    `selected image should expose image actions only, got ${populatedManual.contextButtons}`);
  check(populatedManual.directUnits <= 7, `populated Manual should have at most 7 direct units, got ${populatedManual.directUnits}`);
  await s.eval(`document.getElementById('toolStraight').click()`);
  check(await s.eval(`!document.querySelector('.board-line-settings').hidden`),
    'choosing a drawing tool should reveal line settings');
  console.log('board-toolbar-check: populated Manual ok');

  // Responsive proof: no document-level horizontal overflow and no toolbar
  // element overlap at the target widths. At 768 the Board strip may scroll
  // horizontally, but it must remain contained and usable.
  for (const width of [1440, 1024, 768]) {
    await s.cdp('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:false });
    const layout = await s.eval(`(() => {
      const toolbar=document.querySelector('.toolbar').getBoundingClientRect();
      const groups=document.getElementById('boardToolbarGroups');
      const groupRect=groups.getBoundingClientRect();
      return { toolbarHeight:Math.round(toolbar.height), toolbarWidth:Math.round(toolbar.width),
        groupWidth:Math.round(groupRect.width), groupLeft:Math.round(groupRect.left), groupRight:Math.round(groupRect.right),
        documentWidth:document.documentElement.scrollWidth,
        pageOverflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
        groupsOverflow:groups.scrollWidth > groups.clientWidth,
        menuTrayRight:Math.round(document.querySelector('.board-menu-tray').getBoundingClientRect().right),
        viewport:document.documentElement.clientWidth };
    })()`);
    check(!layout.pageOverflow, `${width}px created document-level horizontal overflow: ${JSON.stringify(layout)}`);
    if (width >= 1024) {
      check(layout.menuTrayRight <= layout.viewport + 1, `${width}px menu tray escaped the viewport: ${JSON.stringify(layout)}`);
    } else {
      check(layout.groupsOverflow, '768px should keep the full Board toolbar available through contained horizontal scrolling');
      check(layout.menuTrayRight <= layout.viewport + 1, `768px should pin File/Export/More at the right edge: ${JSON.stringify(layout)}`);
    }
    if (width === 1440) check(layout.toolbarHeight < 115, `1440px toolbar exceeded two rows: ${layout.toolbarHeight}px`);
  }
  await s.cdp('Emulation.clearDeviceMetricsOverride', {});
  console.log('board-toolbar-check: responsive ok');

  const errors = await s.cdp('Runtime.evaluate', { expression:`window.__toolbarConsoleErrors || []`, returnByValue:true });
  check(Array.isArray(errors.result.value) && errors.result.value.length === 0, 'toolbar run recorded console errors');

  await s.close();
  console.log(`PASS  board-toolbar-check   ${passed}/${passed} assertions ok`);
}

function check(condition, message) {
  if (!condition) {
    process.exitCode = 1;
    throw new Error(message);
  }
  passed += 1;
}

async function openCdpSession(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('no page target available');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once:true });
    ws.addEventListener('error', reject, { once:true });
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
    ws.send(JSON.stringify({ id:requestId, method, params }));
  });
  await cdp('Runtime.enable');
  await cdp('Runtime.evaluate', { expression:`window.__toolbarConsoleErrors=[]; addEventListener('error',e=>window.__toolbarConsoleErrors.push(String(e.message||e.error)))` });
  const evalJs = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
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
  return { eval:evalJs, waitFor, cdp, close:() => ws.close() };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForCdp(port) {
  for (let i=0; i<80; i+=1) {
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
