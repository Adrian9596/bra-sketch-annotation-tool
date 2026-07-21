#!/usr/bin/env node
// Headless tests for Learning Mode toggle consistency.
//
// Drives the live page via CDP — same harness shape as auto-mode-smoke.mjs —
// and exercises the recordAnchorResidual / getAnchorBias / evaluateSample
// path through window.__braAutoModeDebug.learning.
//
// Covers:
//   1. Five consistent corrections activate bias.
//   2. Learning OFF blocks collection and application.
//   3. Duplicate manual samples are ignored.
//   4. Large residuals are rejected.
//   5. Reset Learning clears all residual buckets.
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
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-learning-tests-'));
  const targetUrl = `${baseUrl}/index.html?learningTests=${Date.now()}`;

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
  const result = await runLearningTests(cdp, demoImage);
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
  // Poll from the node side so it survives the execution-context destruction
  // that happens during a Page.navigate (an in-page setInterval would die).
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const ok = await evaluate(cdp, '!!(window.__braAutoModeDebug && window.__braAutoModeDebug.learning)');
      if (ok) return;
    } catch (e) { /* context mid-navigation — retry */ }
    await sleep(150);
  }
  throw new Error('window.__braAutoModeDebug.learning was not exposed within 15s');
}

async function runLearningTests(cdp, imagePath) {
  return await evaluate(cdp, `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const L = debug.learning;
      const tests = [];

      function record(name, pass, reason, details) {
        tests.push({ name, pass, reason: pass ? null : (reason || 'failed'), details });
      }

      // --- TEST 1: Five consistent corrections activate bias --------------
      try {
        L.setEnabled(true);
        L.clearBuckets();
        let recorded = 0;
        for (let i = 0; i < 5; i += 1) {
          if (L.recordResidual('band-left', 0.012, 0.008) === true) recorded += 1;
        }
        const bias = L.getBias('band-left');
        const ok = recorded === 5 && bias.n === 5 && bias.dx > 0 && bias.dy > 0;
        record('5 consistent corrections activate bias', ok,
          'recorded=' + recorded + ' bias=' + JSON.stringify(bias),
          { recorded, bias });
      } catch (e) {
        record('5 consistent corrections activate bias', false, String(e && e.message || e));
      }

      // --- TEST 1b: Band corrections tune detector parameters ------------
      try {
        L.setEnabled(true);
        L.clearBuckets();
        for (let i = 0; i < 5; i += 1) {
          L.recordResidual('band-left', 0, 0.012, {
            kind: 'band-left',
            viewRole: 'front_outer',
            confidence: 'high',
          });
        }
        const params = L.getDetectionParams();
        const samples = L.getParamSamples();
        const bandSamples = samples.bandPreferredRatio || [];
        const ok = bandSamples.length === 5
          && params.sampleCounts.bandPreferredRatio === 5
          && params.bandPreferredRatio > 0.82
          && params.bandSearchStartRatio > 0.58;
        record('Band corrections tune detector parameters', ok,
          'params=' + JSON.stringify(params) + ' samples=' + bandSamples.length,
          { params, bandSamples });
      } catch (e) {
        record('Band corrections tune detector parameters', false, String(e && e.message || e));
      }

      // --- TEST 2: Learning OFF blocks collection AND application --------
      try {
        L.setEnabled(true);
        L.clearBuckets();
        // Seed enough samples for an active bias when enabled.
        for (let i = 0; i < 5; i += 1) L.recordResidual('band-left', 0.02, 0.02);
        const enabledBias = L.getBias('band-left');

        // Now turn learning off.
        L.setEnabled(false);

        // Collection blocked:
        const before = L.getSampleCount();
        const ret = L.recordResidual('chest-left', 0.02, 0.02);
        const after = L.getSampleCount();
        const collectionBlocked = ret === false && before === after;

        // Application blocked: bias() short-circuits because buckets is not
        // re-evaluated under disabled? It still reads the buckets — the
        // actual application gate lives in applyLearningBiasToAnchors.
        const anchors = [{ kind: 'band-left', x: 0.5, y: 0.5, calibrated: false }];
        const applied = L.applyBiasTo(anchors);
        const applicationBlocked = applied[0].x === 0.5 && applied[0].y === 0.5
          && applied[0].calibrated !== true;

        // Restore for next tests.
        L.setEnabled(true);
        L.clearBuckets();

        const ok = collectionBlocked && applicationBlocked;
        record('Learning OFF blocks collection and application', ok,
          'collectionBlocked=' + collectionBlocked + ' applicationBlocked=' + applicationBlocked,
          { ret, before, after, applied, enabledBiasN: enabledBias.n });
      } catch (e) {
        record('Learning OFF blocks collection and application', false, String(e && e.message || e));
      }

      // --- Shared setup for tests 3 + 4: load demo image, run auto draft ---
      let loadedDrafts = null;
      let loadErr = null;
      try {
        const response = await fetch(${JSON.stringify(imagePath)} + '?lt=' + Date.now(), { cache: 'no-store' });
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

      const pom1Draft = loadedDrafts
        ? loadedDrafts.find(d => String(d.seq || d.text) === '1')
        : null;

      // --- TEST 3: Duplicate manual samples are ignored ------------------
      try {
        if (!pom1Draft) throw new Error('POM 1 draft missing; loadErr=' + loadErr);
        L.setEnabled(true);
        L.clearBuckets();
        // Offset from the predicted band endpoints by a few % of the image
        // dimensions so the residual exceeds LEARNING_MIN_DELTA and a real
        // bucket entry gets written — that way we can prove the second
        // call neither adds another entry nor moves the bias.
        const images = debug.getImages();
        const image = images && images[images.length - 1];
        if (!image) throw new Error('no image loaded');
        const dx = image.width  * 0.03;
        const dy = image.height * 0.02;
        const ann = {
          id: 'ltest-3',
          type: 'line',
          text: '1',
          color: 'red',
          style: 'solid',
          width: 2,
          arrows: 'double',
          start: { x: pom1Draft.start.x + dx, y: pom1Draft.start.y + dy },
          end:   { x: pom1Draft.end.x   + dx, y: pom1Draft.end.y   + dy },
        };
        const first  = L.evaluateSample(ann);
        const after1 = L.getSampleCount();
        const second = L.evaluateSample(ann);
        const after2 = L.getSampleCount();

        const ok =
          first.status === 'recorded'
          && after1 > 0
          && second.status === 'skipped'
          && after2 === after1;
        record('Duplicate manual samples are ignored', ok,
          'first=' + first.status + ' second=' + second.status
          + ' after1=' + after1 + ' after2=' + after2,
          { first, second, after1, after2 });
      } catch (e) {
        record('Duplicate manual samples are ignored', false, String(e && e.message || e));
      }

      // --- TEST 3b: Edited Auto-applied lines teach learning -------------
      try {
        if (!pom1Draft) throw new Error('POM 1 draft missing; loadErr=' + loadErr);
        L.setEnabled(true);
        L.clearBuckets();
        const images = debug.getImages();
        const image = images && images[images.length - 1];
        if (!image) throw new Error('no image loaded');
        const dx = image.width  * 0.025;
        const dy = image.height * 0.018;
        const ann = {
          id: 'ltest-3b-auto-applied',
          seq: 1,
          type: pom1Draft.type || 'straight',
          text: null,
          auto: true,
          sourceMode: 'auto-mode',
          autoRunId: 'learning-test-run',
          sourceImageId: image.id,
          start: { x: pom1Draft.start.x + dx, y: pom1Draft.start.y + dy },
          end:   { x: pom1Draft.end.x   + dx, y: pom1Draft.end.y   + dy },
        };
        const first = L.evaluateAutoAppliedSample(ann);
        const after1 = L.getSampleCount();
        const second = L.evaluateAutoAppliedSample(ann);
        const after2 = L.getSampleCount();
        const ok =
          first.status === 'recorded'
          && first.pom === '1'
          && after1 > 0
          && second.status === 'skipped'
          && after2 === after1;
        record('Edited Auto-applied lines teach learning', ok,
          'first=' + first.status + ' pom=' + first.pom
          + ' second=' + second.status + ' after1=' + after1 + ' after2=' + after2,
          { first, second, after1, after2 });
      } catch (e) {
        record('Edited Auto-applied lines teach learning', false, String(e && e.message || e));
      }

      // --- TEST 4: Large residuals are rejected --------------------------
      try {
        if (!pom1Draft) throw new Error('POM 1 draft missing; loadErr=' + loadErr);
        L.setEnabled(true);
        L.clearBuckets();
        // Pull the image so we can place far-away endpoints inside it.
        const images = debug.getImages();
        const image = images && images[images.length - 1];
        if (!image) throw new Error('no image loaded');
        // Endpoints near opposite corners of the image — residual will be
        // > 50% of the image dimension on both axes, tripping the guard.
        const far = {
          id: 'ltest-4',
          type: 'line',
          text: '1',
          color: 'red',
          style: 'solid',
          width: 2,
          arrows: 'double',
          start: { x: image.x + image.width * 0.02, y: image.y + image.height * 0.02 },
          end:   { x: image.x + image.width * 0.98, y: image.y + image.height * 0.98 },
        };
        const r = L.evaluateSample(far);
        const after = L.getSampleCount();
        const ok = r.status === 'skipped' && after === 0;
        record('Large residuals are rejected', ok,
          'status=' + r.status + ' sampleCount=' + after,
          { result: r, sampleCount: after });
      } catch (e) {
        record('Large residuals are rejected', false, String(e && e.message || e));
      }

      // --- TEST 5: Reset Learning clears all residual buckets ------------
      try {
        L.setEnabled(true);
        L.clearBuckets();
        for (let i = 0; i < 5; i += 1) L.recordResidual('band-left',  0.011, 0.009);
        for (let i = 0; i < 5; i += 1) L.recordResidual('chest-left', 0.013, 0.011);
        const seeded = L.getSampleCount();
        L.clearBuckets();
        const cleared = L.getSampleCount();
        const buckets = L.getBuckets();
        const paramSamples = L.getParamSamples();
        const bucketCount = buckets ? Object.keys(buckets).length : -1;
        const paramBucketCount = paramSamples ? Object.keys(paramSamples).length : -1;
        const biasAfter = L.getBias('band-left');
        const paramsAfter = L.getDetectionParams();
        const ok =
          seeded === 10
          && cleared === 0
          && bucketCount === 0
          && paramBucketCount === 0
          && biasAfter.dx === 0
          && biasAfter.dy === 0
          && paramsAfter.bandPreferredRatio === 0.82
          && paramsAfter.rowNoiseMultiplier === 1;
        record('Reset Learning clears all residual buckets', ok,
          'seeded=' + seeded + ' cleared=' + cleared + ' bucketCount=' + bucketCount
          + ' paramBucketCount=' + paramBucketCount,
          { seeded, cleared, bucketCount, paramBucketCount, biasAfter, paramsAfter });
      } catch (e) {
        record('Reset Learning clears all residual buckets', false, String(e && e.message || e));
      }

      // --- TEST 6: Phase 8 stage attribution + sample context -------------
      // A correction below the nudge limit is an 'anchor-nudge' regardless of
      // detection state; a large one must be attributed to a real pipeline
      // stage (which one depends on the fixture's detection — the learning
      // fixture's geometry frame is flagged weak, so geometry-wrong is a
      // legitimate verdict) and the recorded sample must carry the SAME
      // attribution plus the Phase 8 context fields (part / style / conf),
      // without disturbing the bias math.
      try {
        L.setEnabled(true);
        L.clearBuckets();
        const STAGES = ['segmentation-weak', 'contour-missing', 'geometry-wrong', 'landmark-wrong'];
        const nudge = L.classifyResidual('band-left', 0.005, 0.004);
        const large = L.classifyResidual('band-left', 0.03, 0.02);
        L.recordResidual('band-left', 0.03, 0.02,
          { kind: 'band-left', viewRole: 'front_outer', confidence: 'high' });
        const buckets = L.getBuckets();
        const sample = (buckets['band-left|front_outer'] || [])[0] || null;
        const bias = L.getBias('band-left', { kind: 'band-left', viewRole: 'front_outer' });
        const summary = L.summarize();
        const stageCounts = summary && summary.stageCounts ? summary.stageCounts : {};
        const ok = nudge === 'anchor-nudge'
          && STAGES.indexOf(large) >= 0
          && !!sample
          && sample.stage === large
          && sample.part === 'bottomBand'
          && typeof sample.style === 'string' && sample.style.length > 0
          && sample.conf === 'high'
          && bias.n === 1
          && stageCounts[large] === 1;
        record('Stage attribution + context recorded on corrections', ok,
          'nudge=' + nudge + ' large=' + large + ' sample=' + JSON.stringify(sample)
          + ' stageCounts=' + JSON.stringify(stageCounts),
          { nudge, large, sample, stageCounts });
      } catch (e) {
        record('Stage attribution + context recorded on corrections', false, String(e && e.message || e));
      }

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
