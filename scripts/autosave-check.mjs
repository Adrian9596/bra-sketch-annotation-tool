#!/usr/bin/env node
// End-to-end verification of the autosave / restore-on-reload flow.
// Boots the app in headless Chrome, injects a state edit via the app's
// public helpers, waits for the debounced autosave, then reloads and
// asserts the restore banner shows and Restore recovers the annotation.
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

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  const baseUrl = started.baseUrl;
  cleanupTasks.push(() => new Promise((r) => server.close(r)));

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'autosave-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));

  const chromeArgs = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `${baseUrl}/index.html?smoke=${Date.now()}`,
  ];
  chrome = spawn(CHROME, chromeArgs);
  cleanupTasks.push(() => new Promise((r) => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);

  const session = await openCdpSession(cdpPort);

  // Wait for the app to be up: renderSpecPanel has rendered rows.
  await session.waitFor(`document.querySelectorAll('#specBody tr').length > 0`, 8000);

  // Step 1 — load a synthetic project with one annotation. loadProject
  // deliberately clears the autosave slot; we then flush the autosave
  // manually to re-write from the loaded state.
  const seeded = await session.eval(`(async () => {
    const api = window.__braAutoModeDebug;
    if (!api || typeof api.loadProject !== 'function') return { ok: false, reason: 'no debug api' };
    await api.loadProject({
      format: 'bra-sketch-project',
      version: 1,
      savedAt: new Date().toISOString(),
      state: {
        annotations: [{
          id: 1, seq: 1, type: 'straight',
          start: { x: 100, y: 100 }, end: { x: 200, y: 200 },
          color: 'red', text: '11', value: null, desc: null,
        }],
        images: [], eraseStrokes: [], brushSize: 24, showLabels: true,
        calibration: { unitsPerPx: null, unit: 'cm' },
        nextSequence: 2, idCounter: 2,
        drawStyle: 'solid', drawColor: 'red', arrowType: 'double', lineWidth: 2.5,
        zoom: 1, panX: 0, panY: 0, styleId: '', pomSpecs: {},
      },
    });
    api.autosave.flush();
    return { ok: true };
  })()`);
  assert(seeded.ok, 'Could not seed annotation: ' + (seeded.reason || 'unknown'));

  // Step 2 — confirm localStorage now holds a record for the annotation.
  const savedRaw = await session.eval(`window.__braAutoModeDebug.autosave.peek()`);
  assert(!!savedRaw, 'autosave record was not written to localStorage');
  const saved = JSON.parse(savedRaw);
  assert(
    saved && saved.snapshot && saved.snapshot.state
      && Array.isArray(saved.snapshot.state.annotations)
      && saved.snapshot.state.annotations.length === 1,
    'autosave snapshot did not include the annotation we seeded'
  );
  assert(saved.snapshot.state.annotations[0].text === '11', 'autosave snapshot lost the annotation label');

  await session.close();

  // Step 3 — reload the tab in a way that preserves localStorage but
  // clears in-memory state. beforeunload dialogs are suppressed in
  // headless mode, so this reload just re-navigates.
  const session2 = await openCdpSession(cdpPort);
  await session2.eval(`window.location.reload()`);
  await sleep(400);
  // Reconnect: after reload the page target has a new websocket URL.
  await session2.close();
  const session3 = await openCdpSession(cdpPort);

  await session3.waitFor(`!!document.getElementById('autosaveRestoreBanner')`, 8000);
  const bannerText = await session3.eval(`document.getElementById('autosaveRestoreBanner').innerText`);
  assert(/Recovered work available/i.test(bannerText), 'restore banner text missing headline');

  // Step 4 — click Restore and confirm the annotation ends up back on
  // the board.
  await session3.eval(`
    Array.from(document.querySelectorAll('#autosaveRestoreBanner button'))
      .find(b => /Restore/i.test(b.textContent))
      .click();
  `);
  // exportProject reflects the live post-restore state.
  await session3.waitFor(`
    !!window.__braAutoModeDebug
    && window.__braAutoModeDebug.exportProject().state.annotations.length === 1
  `, 6000);
  const restoredLabel = await session3.eval(`
    window.__braAutoModeDebug.exportProject().state.annotations[0].text
  `);
  assert(restoredLabel === '11', 'restored annotation lost its label; got ' + restoredLabel);

  // Step 5 — autosave should be cleared after a successful restore so
  // the banner does not re-appear.
  const postRestoreRaw = await session3.eval(`window.__braAutoModeDebug.autosave.peek()`);
  assert(!postRestoreRaw, 'autosave record was not cleared after restore');

  await session3.close();
  console.log('PASS  autosave-check');
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL  ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

async function openCdpSession(port) {
  // Poll until Chrome exposes a page target after reload.
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
  if (err && err.message) console.error('FAIL', err.message);
} finally {
  for (const task of cleanupTasks.reverse()) {
    try { await task(); } catch (_) {}
  }
}
