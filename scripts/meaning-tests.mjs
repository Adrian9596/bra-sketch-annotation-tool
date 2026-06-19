#!/usr/bin/env node
// Headless tests for Meaning-Aware Learning.
//
// Drives the live page via CDP and exercises the (style, POM) meaning
// catalog, the popover cancel path, the canvas-keyboard block, and the
// reset-separation guarantee through window.__braAutoModeDebug.meaning.
//
// Covers:
//   1. Meaning scope: Style A POM 9 and Style B POM 9 don't collide.
//   2. Reconfirm forgets the prior binding and re-opens the popover.
//   3. Cancel keeps the line and records nothing.
//   4. Popover blocks canvas keyboard shortcuts (L / S / B).
//   5. Reset Learning leaves meanings intact; Reset Meanings leaves
//      residuals intact.
//   6. Ranking blends distance with recency-weighted usage.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_DEMO_IMAGE = 'demo/demo1.jpg';

const args = parseArgs(process.argv.slice(2));
const chromePath = args.chrome || process.env.CHROME_PATH || DEFAULT_CHROME;
const demoImage = args.image || DEFAULT_DEMO_IMAGE;
const keepBrowser = Boolean(args.keepBrowser);

if (!existsSync(chromePath)) {
  fail(`Chrome not found at ${chromePath}. Pass --chrome=/path/to/chrome or set CHROME_PATH.`);
}
if (!existsSync(path.join(appDir, demoImage))) {
  fail(`Demo image not found: ${demoImage}`);
}

let server;
let chrome;
let userDataDir;

try {
  const { server: httpServer, baseUrl } = await startStaticServer(appDir);
  server = httpServer;

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-meaning-tests-'));
  const targetUrl = `${baseUrl}/index.html?meaningTests=${Date.now()}`;

  chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    targetUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let chromeStderr = '';
  chrome.stderr.on('data', chunk => { chromeStderr += String(chunk); });

  const target = await waitForChromeTarget(cdpPort, targetUrl);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);

  await cdp.send('Runtime.enable');
  await waitForDebugApi(cdp);
  const result = await runMeaningTests(cdp, demoImage);
  await cdp.close();

  const failures = result.tests.filter(t => !t.pass);
  const output = {
    status: failures.length === 0 ? 'pass' : 'fail',
    image: demoImage,
    tests: result.tests,
    failures: failures.map(t => `${t.name}: ${t.reason || 'failed'}`),
  };
  console.log(JSON.stringify(output, null, 2));
  if (failures.length) process.exitCode = 1;

  if (chromeStderr && args.verbose) console.error(chromeStderr.trim());
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  if (chrome && !keepBrowser) await stopChrome(chrome);
  if (server) await new Promise(resolve => server.close(resolve));
  if (userDataDir && !keepBrowser) await removeWithRetry(userDataDir);
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === '--keep-browser') parsed.keepBrowser = true;
    else if (arg === '--verbose') parsed.verbose = true;
    else if (arg.startsWith('--chrome=')) parsed.chrome = arg.slice('--chrome='.length);
    else if (arg.startsWith('--image=')) parsed.image = arg.slice('--image='.length);
    else fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function waitForChromeTarget(port, targetUrl) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(t => t.type === 'page' && t.url === targetUrl)
          || targets.find(t => t.type === 'page');
        if (target && target.webSocketDebuggerUrl) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`Chrome DevTools target was not ready.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else request.resolve(message.result || {});
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() { ws.close(); },
  };
}

async function waitForDebugApi(cdp) {
  await evaluate(cdp, `
    new Promise((resolve, reject) => {
      let checks = 0;
      const timer = setInterval(() => {
        checks += 1;
        if (window.__braAutoModeDebug
            && window.__braAutoModeDebug.learning
            && window.__braAutoModeDebug.meaning) {
          clearInterval(timer);
          resolve(true);
        } else if (checks > 100) {
          clearInterval(timer);
          reject(new Error('window.__braAutoModeDebug.meaning was not exposed'));
        }
      }, 100);
    })
  `);
}

async function runMeaningTests(cdp, imagePath) {
  return await evaluate(cdp, `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const L = debug.learning;
      const M = debug.meaning;
      const tests = [];

      function record(name, pass, reason, details) {
        tests.push({ name, pass, reason: pass ? null : (reason || 'failed'), details });
      }

      // --- Shared setup: load demo image, run auto draft -----------------
      let loadedDrafts = null;
      let loadErr = null;
      try {
        const response = await fetch(${JSON.stringify(imagePath)} + '?mt=' + Date.now(), { cache: 'no-store' });
        if (!response.ok) throw new Error('fetch ' + response.status);
        const blob = await response.blob();
        const dataURL = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('FileReader failed'));
          reader.readAsDataURL(blob);
        });
        await debug.runAutoOnDataUrl(dataURL);
        loadedDrafts = debug.getDrafts();
      } catch (e) {
        loadErr = String(e && e.message || e);
      }

      // Get an image-grounded straight line we can call "POM 9". Reuse a
      // POM 1 draft's endpoints — geometry doesn't matter for binding
      // tests, only that the line lives on an image so pickImageForAnnotation
      // resolves.
      const refDraft = loadedDrafts
        ? loadedDrafts.find(d => String(d.seq || d.text) === '1')
        : null;

      function makeAnn(id, text) {
        if (!refDraft) return null;
        const start = { x: refDraft.start.x, y: refDraft.start.y };
        const end   = { x: refDraft.end.x,   y: refDraft.end.y };
        return {
          id,
          type: 'line',
          text: String(text),
          color: 'red',
          style: 'solid',
          width: 2,
          arrows: 'double',
          start,
          end,
          // openPomMeaningPopover positions itself at ann.label — anchor
          // it to the line midpoint so the synthetic ann doesn't crash
          // worldToScreen.
          label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
        };
      }

      function fullReset() {
        L.setEnabled(true);
        L.clearBuckets();
        M.clearAll();
        M.setStyleId('');
      }

      // --- TEST 1: Meaning scope — Style A POM 9 ≠ Style B POM 9 --------
      try {
        if (!refDraft) throw new Error('reference draft missing; loadErr=' + loadErr);
        fullReset();

        M.setStyleId('STYLE-A');
        M.confirm('9', 'cup-height');
        const resolvedAInA = M.resolve('9');

        M.setStyleId('STYLE-B');
        const resolvedBeforeBindB = M.resolve('9');
        M.confirm('9', 'side-height');
        const resolvedBInB = M.resolve('9');

        M.setStyleId('STYLE-A');
        const resolvedAStillA = M.resolve('9');

        const ok =
          resolvedAInA && resolvedAInA.id === 'cup-height'
          && resolvedBeforeBindB === null
          && resolvedBInB && resolvedBInB.id === 'side-height'
          && resolvedAStillA && resolvedAStillA.id === 'cup-height';

        record('Meaning scope: same POM in two styles stays independent', ok,
          'A.9=' + (resolvedAInA && resolvedAInA.id)
          + ' B.9=' + (resolvedBInB && resolvedBInB.id)
          + ' A.9 after B=' + (resolvedAStillA && resolvedAStillA.id),
          { resolvedAInA, resolvedBeforeBindB, resolvedBInB, resolvedAStillA });
      } catch (e) {
        record('Meaning scope: same POM in two styles stays independent', false, String(e && e.message || e));
      }

      // --- TEST 2: Reconfirm forgets prior binding and re-prompts --------
      try {
        if (!refDraft) throw new Error('reference draft missing; loadErr=' + loadErr);
        fullReset();
        M.setStyleId('STYLE-RC');
        M.confirm('9', 'cup-height');
        const before = M.resolve('9');
        const forgotten = M.forget('9');
        const after = M.resolve('9');

        // Simulate the popover path used by reconfirm: evaluating an
        // unbound POM 9 line should now ask for confirmation.
        const ann = makeAnn(9001, '9');
        const evalRes = M.openPopoverForAnn(ann);
        const popoverOpen = M.isPopoverOpen();
        M.cancelPopover();
        const popoverClosed = M.isPopoverOpen();

        const ok =
          before && before.id === 'cup-height'
          && forgotten === true
          && after === null
          && evalRes.status === 'needsConfirmation'
          && popoverOpen === true
          && popoverClosed === false;

        record('Reconfirm Meaning forgets binding and re-opens popover', ok,
          'before=' + (before && before.id) + ' after=' + after
          + ' popoverOpen=' + popoverOpen + ' status=' + evalRes.status,
          { before, after, forgotten, evalRes, popoverOpen, popoverClosed });
      } catch (e) {
        record('Reconfirm Meaning forgets binding and re-opens popover', false, String(e && e.message || e));
      }

      // --- TEST 3: Cancel keeps the line, records no learning sample -----
      try {
        if (!refDraft) throw new Error('reference draft missing; loadErr=' + loadErr);
        fullReset();
        M.setStyleId('STYLE-CANCEL');

        const ann = makeAnn(9002, '9');
        const before = L.getSampleCount();
        const evalRes = M.openPopoverForAnn(ann);
        const popoverOpen = M.isPopoverOpen();
        // Cancel — closes popover without commit.
        M.cancelPopover();
        const after = L.getSampleCount();
        const stillBound = M.resolve('9');

        const ok =
          evalRes.status === 'needsConfirmation'
          && popoverOpen === true
          && after === before
          && stillBound === null;  // cancel does NOT commit a binding

        record('Cancel keeps the line and records no learning sample', ok,
          'before=' + before + ' after=' + after + ' stillBound=' + stillBound,
          { evalRes, popoverOpen, before, after, stillBound });
      } catch (e) {
        record('Cancel keeps the line and records no learning sample', false, String(e && e.message || e));
      }

      // --- TEST 4: Popover blocks canvas keyboard shortcuts --------------
      try {
        if (!refDraft) throw new Error('reference draft missing; loadErr=' + loadErr);
        fullReset();
        M.setStyleId('STYLE-KB');
        // Auto Mode disables L/B/C/E/etc regardless of the popover. The
        // popover gate only kicks in if we're in Manual Mode to begin
        // with — that's the workflow it's protecting in production.
        M.setAppMode('manual');

        const ann = makeAnn(9003, '9');
        M.openPopoverForAnn(ann);
        const popoverOpen = M.isPopoverOpen();
        const toolBefore = M.getCanvasTool();

        // Dispatch the L / B / C shortcuts that would normally swap the
        // active tool. The popover gate in onKeyDown should swallow them.
        function fire(key, code) {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key, code, bubbles: true, cancelable: true,
          }));
        }
        fire('l', 'KeyL');
        const toolAfterL = M.getCanvasTool();
        fire('b', 'KeyB');
        const toolAfterB = M.getCanvasTool();
        fire('c', 'KeyC');
        const toolAfterC = M.getCanvasTool();
        fire('s', 'KeyS');
        const toolAfterS = M.getCanvasTool();

        M.cancelPopover();
        // Sanity: once the popover is gone, shortcuts work again.
        fire('l', 'KeyL');
        const toolAfterReopen = M.getCanvasTool();

        const ok =
          popoverOpen === true
          && toolAfterL === toolBefore
          && toolAfterB === toolBefore
          && toolAfterC === toolBefore
          && toolAfterS === toolBefore
          && toolAfterReopen === 'straight';

        record('Popover blocks canvas keyboard shortcuts', ok,
          'before=' + toolBefore + ' L=' + toolAfterL + ' B=' + toolAfterB
          + ' C=' + toolAfterC + ' S=' + toolAfterS
          + ' reopen=' + toolAfterReopen,
          { toolBefore, toolAfterL, toolAfterB, toolAfterC, toolAfterS, toolAfterReopen });
      } catch (e) {
        record('Popover blocks canvas keyboard shortcuts', false, String(e && e.message || e));
      }

      // --- TEST 5: Reset Learning ↮ Reset Meanings stay independent -----
      try {
        fullReset();
        L.setEnabled(true);
        // Seed residuals + meanings in both stores.
        for (let i = 0; i < 5; i += 1) L.recordResidual('band-left', 0.012, 0.008);
        M.setStyleId('STYLE-RS');
        M.confirm('9', 'cup-height');
        M.confirm('10', 'side-height');

        const seededLearning = L.getSampleCount();
        const seededMeanings = M.listForStyle('STYLE-RS').length;

        // Reset Learning — residuals only.
        L.clearBuckets();
        const learningAfterReset = L.getSampleCount();
        const meaningsAfterLearningReset = M.listForStyle('STYLE-RS').length;

        // Re-seed residuals, then Reset Meanings.
        for (let i = 0; i < 5; i += 1) L.recordResidual('band-left', 0.012, 0.008);
        const residualsBeforeMeaningsReset = L.getSampleCount();
        M.clearAll();
        const residualsAfterMeaningsReset = L.getSampleCount();
        const meaningsAfterMeaningsReset = M.listForStyle('STYLE-RS').length;

        const ok =
          seededLearning === 5
          && seededMeanings === 2
          && learningAfterReset === 0
          && meaningsAfterLearningReset === 2     // meanings survived
          && residualsBeforeMeaningsReset === 5
          && residualsAfterMeaningsReset === 5    // residuals survived
          && meaningsAfterMeaningsReset === 0;

        record('Reset Learning and Reset Meanings stay independent', ok,
          'learn(reset)=' + learningAfterReset
          + ' meaningsKept=' + meaningsAfterLearningReset
          + ' residualsKept=' + residualsAfterMeaningsReset
          + ' meanings(reset)=' + meaningsAfterMeaningsReset,
          {
            seededLearning, seededMeanings,
            learningAfterReset, meaningsAfterLearningReset,
            residualsBeforeMeaningsReset, residualsAfterMeaningsReset,
            meaningsAfterMeaningsReset,
          });
      } catch (e) {
        record('Reset Learning and Reset Meanings stay independent', false, String(e && e.message || e));
      }

      // --- TEST 6: Ranking factors recency-weighted usage ---------------
      // Equal endpoint geometry → distance ties → tiebreaker should
      // prefer the recently-used meaning even when an older meaning has
      // a much higher raw count.
      try {
        if (!refDraft) throw new Error('reference draft missing; loadErr=' + loadErr);
        fullReset();

        // Build a line whose endpoints sit at the center of the image so
        // every meaning gets the same anchor-pair distance (zero variance
        // in d), making usage the deciding factor.
        const images = debug.getImages();
        const image = images && images[images.length - 1];
        if (!image) throw new Error('no image loaded');
        const cx = image.x + image.width * 0.5;
        const cy = image.y + image.height * 0.5;
        const ann = {
          id: 9004,
          type: 'line',
          text: '9',
          color: 'red',
          style: 'solid',
          width: 2,
          arrows: 'double',
          start: { x: cx, y: cy },
          end:   { x: cx + 1, y: cy + 1 },
        };

        // Stale heavyweight (200 uses, 200 days ago) vs fresh light
        // (3 uses, today). Recency must outweigh raw count here.
        const longAgo = Date.now() - 200 * 86400000;
        M.seedUsage('cup-height', 200, longAgo);
        M.seedUsage('side-height',  3, Date.now());

        const stalePriority = M.usagePriority('cup-height');
        const freshPriority = M.usagePriority('side-height');

        // Build a synthetic suggestion list directly to check sort order.
        const suggestions = M.suggest(ann, 3);
        const ids = suggestions.map(s => s.id);

        // Fresh should outrank stale.
        const idxFresh = ids.indexOf('side-height');
        const idxStale = ids.indexOf('cup-height');
        const ok =
          freshPriority > stalePriority
          && idxFresh !== -1
          && (idxStale === -1 || idxFresh < idxStale);

        record('Ranking factors recency-weighted usage', ok,
          'freshPrio=' + freshPriority.toFixed(3)
          + ' stalePrio=' + stalePriority.toFixed(3)
          + ' order=' + JSON.stringify(ids),
          { stalePriority, freshPriority, ids });
      } catch (e) {
        record('Ranking factors recency-weighted usage', false, String(e && e.message || e));
      }

      // Final cleanup so we don't leak state into other test runs on
      // this profile (unlikely with the per-run user-data-dir, but free).
      try { fullReset(); } catch (_) {}

      return { tests };
    })()
  `);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception && details.exception.description
      ? details.exception.description
      : details.text || 'Runtime.evaluate failed';
    throw new Error(message);
  }
  return result.result ? result.result.value : undefined;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function stopChrome(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  proc.kill('SIGTERM');
  const exited = new Promise(resolve => proc.once('exit', resolve));
  const timedOut = sleep(2500).then(() => 'timeout');
  const result = await Promise.race([exited, timedOut]);
  if (result === 'timeout' && proc.exitCode === null) {
    proc.kill('SIGKILL');
    await Promise.race([exited, sleep(1000)]);
  }
}

async function removeWithRetry(targetPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.error(`Warning: could not remove temporary Chrome profile ${targetPath}: ${error.message}`);
        return;
      }
      await sleep(150 * (attempt + 1));
    }
  }
}
