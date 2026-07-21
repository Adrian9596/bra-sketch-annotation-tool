#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_DEMO_IMAGE = 'demo/demo1.jpg';
const EXPECTED_DRAFT_COUNT = 18;
const MIN_HIGH_CONFIDENCE = Number(process.env.AUTO_SMOKE_MIN_HIGH_CONFIDENCE || 1);
const TELEMETRY_BASELINE_PATH = path.join(scriptDir, 'golden', 'telemetry-baseline.json');

const args = parseArgs(process.argv.slice(2));
const chromePath = args.chrome || process.env.CHROME_PATH || DEFAULT_CHROME;
const demoImage = args.image || DEFAULT_DEMO_IMAGE;
const keepBrowser = Boolean(args.keepBrowser);
const telemetryBaseline = Boolean(args.telemetryBaseline);
const telemetryLimit = Number(args.limit || 10);

if (!existsSync(chromePath)) {
  fail(`Chrome not found at ${chromePath}. Pass --chrome=/path/to/chrome or set CHROME_PATH.`);
}

if (!telemetryBaseline && !existsSync(path.join(appDir, demoImage))) {
  fail(`Demo image not found: ${demoImage}`);
}

const telemetryImages = telemetryBaseline
  ? listDemoImages(args.image ? [args.image] : null, telemetryLimit)
  : [demoImage];
if (telemetryBaseline && telemetryImages.length === 0) {
  fail('No demo images found for telemetry baseline.');
}

let server;
let chrome;
let userDataDir;

try {
  const { server: httpServer, baseUrl } = await startStaticServer(appDir);
  server = httpServer;

  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-auto-mode-smoke-'));
  const targetUrl = `${baseUrl}/index.html?smoke=${Date.now()}`;

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
  chrome.stderr.on('data', chunk => {
    chromeStderr += String(chunk);
  });

  const target = await waitForChromeTarget(cdpPort, targetUrl);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitForDebugApi(cdp);

  if (telemetryBaseline) {
    const entries = [];
    let anyFail = false;
    for (let i = 0; i < telemetryImages.length; i += 1) {
      const image = telemetryImages[i];
      await cdp.send('Page.navigate', { url: `${targetUrl}&telemetryCase=${i}` });
      await waitForDebugApi(cdp);
      const result = await runAutoModeSmoke(cdp, image);
      const checks = evaluateChecks(result);
      if (checks.length) anyFail = true;
      entries.push({
        image,
        status: checks.length === 0 ? 'pass' : 'fail',
        failures: checks,
        metrics: pickTelemetryBaselineMetrics(result),
        telemetry: result.telemetry && result.telemetry.latest ? result.telemetry.latest : null,
      });
    }

    const baseline = {
      generatedAt: new Date().toISOString(),
      requestedEntryCount: telemetryLimit,
      actualEntryCount: entries.length,
      note: entries.length < telemetryLimit
        ? `Only ${entries.length} demo image(s) are present in demo/. Add more fixtures to reach the requested ${telemetryLimit}.`
        : '',
      medians: summarizeTelemetryEntryMedians(entries),
      entries,
    };
    mkdirSync(path.dirname(TELEMETRY_BASELINE_PATH), { recursive: true });
    writeFileSync(TELEMETRY_BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');

    console.log(JSON.stringify({
      status: anyFail ? 'fail' : 'pass',
      wrote: path.relative(appDir, TELEMETRY_BASELINE_PATH),
      actualEntryCount: entries.length,
      requestedEntryCount: telemetryLimit,
      medians: baseline.medians,
      failures: entries.filter(e => e.failures.length).map(e => ({ image: e.image, failures: e.failures })),
    }, null, 2));
    if (anyFail) process.exitCode = 1;
    await cdp.close();
    if (chromeStderr && args.verbose) {
      console.error(chromeStderr.trim());
    }
  } else {
  const result = await runAutoModeSmoke(cdp, demoImage);
  await cdp.close();

  const checks = evaluateChecks(result);
  const output = {
    status: checks.length === 0 ? 'pass' : 'fail',
    image: demoImage,
    expectedDraftCount: EXPECTED_DRAFT_COUNT,
    minHighConfidence: MIN_HIGH_CONFIDENCE,
    metrics: result,
    failures: checks,
  };

  console.log(JSON.stringify(output, null, 2));
  if (checks.length) process.exitCode = 1;

  if (chromeStderr && args.verbose) {
    console.error(chromeStderr.trim());
  }
  }
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
    else if (arg === '--telemetry-baseline') parsed.telemetryBaseline = true;
    else if (arg.startsWith('--chrome=')) parsed.chrome = arg.slice('--chrome='.length);
    else if (arg.startsWith('--image=')) parsed.image = arg.slice('--image='.length);
    else if (arg.startsWith('--limit=')) parsed.limit = Number(arg.slice('--limit='.length));
    else fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function listDemoImages(onlyImages, limit) {
  if (Array.isArray(onlyImages) && onlyImages.length) {
    return onlyImages.filter(image => existsSync(path.join(appDir, image)));
  }
  return readdirSync(path.join(appDir, 'demo'))
    .filter(file => /\.(jpe?g|png|webp)$/i.test(file))
    .sort()
    .slice(0, Math.max(1, limit || 10))
    .map(file => `demo/${file}`);
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
    close() {
      ws.close();
    },
  };
}

async function waitForDebugApi(cdp) {
  // Poll from the node side so it survives the execution-context destruction
  // that happens during initial load and Page.navigate (an in-page
  // setInterval promise would die with the context and reject the evaluate).
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const ok = await evaluate(cdp, 'typeof window.__braAutoModeDebug !== "undefined" && !!window.__braAutoModeDebug');
      if (ok) return;
    } catch (e) { /* context mid-navigation — retry */ }
    await sleep(150);
  }
  throw new Error('window.__braAutoModeDebug was not exposed within 15s');
}

async function runAutoModeSmoke(cdp, imagePath) {
  return await evaluate(cdp, `
    (async () => {
      const debug = window.__braAutoModeDebug;
      if (debug.clearTelemetryLog) debug.clearTelemetryLog();
      const response = await fetch(${JSON.stringify(imagePath)} + '?smoke=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not fetch smoke image: ' + response.status);
      const blob = await response.blob();
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read smoke image'));
        reader.readAsDataURL(blob);
      });

      // Capture CV debug output on the first run so we can prove the
      // debug API is wired up end-to-end (anchors, learned params, stage
      // timings all reach the export).
      const runResult = await debug.runAutoOnDataUrl(dataURL, { cvDebug: true });
      const cvDebugBlob = runResult && runResult.cvDebug;
      const cvExport = runResult && runResult.cvExport;
      const stateAfterDraft = debug.getState();
      const drafts = debug.getDrafts();
      const validation = stateAfterDraft.validation || {};
      const highConfidencePoms = drafts
        .filter(d => d.confidence === 'high')
        .map(d => String(d.seq || d.text));
      const reviewOnlyPoms = drafts
        .filter(d => d.drawability === 'REVIEW_ONLY')
        .map(d => String(d.seq || d.text));
      const reviewOnlyApproved = drafts
        .filter(d => d.drawability === 'REVIEW_ONLY' && d.tdApproved)
        .map(d => String(d.seq || d.text));

      const approvedCount = debug.approveDrawableDrafts();
      const appliedOk = debug.applyApprovedDrafts();
      const telemetryLog = debug.getTelemetryLog ? debug.getTelemetryLog() : [];
      const telemetryReport = debug.getTelemetryReport ? debug.getTelemetryReport(10) : null;
      const project = debug.exportProject();
      const appliedAnnotations = project.state.annotations.filter(a => a.auto);
      const requiredMetadata = [
        'sourceMode',
        'sourceImageId',
        'autoRunId',
        'templateVersion',
        'ruleVersion',
        'drawability',
        'confidence',
        'approvedAt',
        'originDraftId',
      ];
      const missingMetadata = appliedAnnotations.flatMap((ann, index) => {
        const pom = String(ann.seq || ann.text || index + 1);
        const missing = [];
        if (ann.auto !== true) missing.push('auto');
        if (ann.tdApproved !== true) missing.push('tdApproved');
        for (const field of requiredMetadata) {
          if (ann[field] == null || ann[field] === '') missing.push(field);
        }
        return missing.map(field => 'POM ' + pom + ': ' + field);
      });

      const serialized = JSON.stringify(project);
      await debug.loadProject(JSON.parse(serialized));
      const reopenedState = debug.getState();
      const reopenedAutoAnnotations = debug.getAnnotations().filter(a => a.auto);
      const reopenedMissingMetadata = reopenedAutoAnnotations.flatMap((ann, index) => {
        const pom = String(ann.seq || ann.text || index + 1);
        const missing = [];
        if (ann.auto !== true) missing.push('auto');
        if (ann.tdApproved !== true) missing.push('tdApproved');
        for (const field of requiredMetadata) {
          if (ann[field] == null || ann[field] === '') missing.push(field);
        }
        return missing.map(field => 'POM ' + pom + ': ' + field);
      });

      // Summarize the CV debug payload — full blob is too large for the
      // smoke summary, so we just confirm the key fields are present so a
      // regression in the debug surface fails the smoke run.
      const cvDebugSummary = cvDebugBlob ? {
        present: true,
        hasMaskPng: typeof cvDebugBlob.maskPng === 'string' && cvDebugBlob.maskPng.length > 0,
        sampleWidth: cvDebugBlob.sampleWidth || null,
        sampleHeight: cvDebugBlob.sampleHeight || null,
        keptComponentCount: cvDebugBlob.components ? cvDebugBlob.components.keptComponentCount : 0,
        viewBoxCount: Array.isArray(cvDebugBlob.viewBoxes) ? cvDebugBlob.viewBoxes.length : 0,
        hasStageTimings: !!(cvDebugBlob.stageTimingsMs
          && typeof cvDebugBlob.stageTimingsMs.assembleDetection === 'number'),
        bandRow: cvDebugBlob.rows ? cvDebugBlob.rows.bandRow : null,
        chestRow: cvDebugBlob.rows ? cvDebugBlob.rows.chestRow : null,
        cradleRow: cvDebugBlob.rows ? cvDebugBlob.rows.cradleRow : null,
        sideLeftCol: cvDebugBlob.cols ? cvDebugBlob.cols.sideLeftCol : null,
        sideRightCol: cvDebugBlob.cols ? cvDebugBlob.cols.sideRightCol : null,
        hasDetectionParams: !!(cvDebugBlob.detectionParams
          && typeof cvDebugBlob.detectionParams.bandPreferredRatio === 'number'),
      } : { present: false };
      const cvExportSummary = cvExport ? {
        anchorCount: Array.isArray(cvExport.anchors) ? cvExport.anchors.length : 0,
        hasLearningSampleCount: typeof (cvExport.learning && cvExport.learning.sampleCount) === 'number',
        hasLearnedParams: !!(cvExport.learning && cvExport.learning.learnedParams),
        hasValidation: cvExport.validation != null,
        hasDetectionParams: !!(cvExport.detection && cvExport.detection.detectionParams),
        hasThresholds: !!(cvExport.detection && cvExport.detection.thresholds
          && typeof cvExport.detection.thresholds.ink === 'number'),
      } : null;

      return {
        draftCount: drafts.length,
        validationStatus: validation.status || null,
        validationErrors: validation.errors || [],
        validationWarnings: validation.warnings || [],
        highConfidenceCount: highConfidencePoms.length,
        highConfidencePoms,
        reviewOnlyCount: reviewOnlyPoms.length,
        reviewOnlyPoms,
        reviewOnlyApproved,
        approvedCount,
        appliedOk,
        appliedAutoAnnotationCount: appliedAnnotations.length,
        missingMetadata,
        reopenedAppMode: reopenedState.appMode,
        reopenedDraftCount: reopenedState.draftCount,
        reopenedAutoAnnotationCount: reopenedAutoAnnotations.length,
        reopenedMissingMetadata,
        cvDebug: cvDebugSummary,
        cvExport: cvExportSummary,
        telemetry: {
          latest: telemetryLog.length ? telemetryLog[telemetryLog.length - 1] : null,
          report: telemetryReport,
        },
      };
    })()
  `);
}

function pickTelemetryBaselineMetrics(result) {
  const latest = result.telemetry && result.telemetry.latest;
  const summary = latest && latest.summary ? latest.summary : {};
  return {
    draftCount: result.draftCount,
    approvedCount: result.approvedCount,
    appliedAutoAnnotationCount: result.appliedAutoAnnotationCount,
    detect_ms: summary.detect_ms ?? null,
    edit_ms: summary.edit_ms ?? null,
    apply_ms: summary.apply_ms ?? null,
    anchors_dragged: summary.anchors_dragged ?? null,
    drafts_edited: summary.drafts_edited ?? null,
    drafts_discarded: summary.drafts_discarded ?? null,
    touchless: !!summary.touchless,
  };
}

function summarizeTelemetryEntryMedians(entries) {
  const metrics = entries.map(e => e.metrics || {});
  return {
    detect_ms: median(metrics.map(m => m.detect_ms)),
    edit_ms: median(metrics.map(m => m.edit_ms)),
    apply_ms: median(metrics.map(m => m.apply_ms)),
    anchors_dragged: median(metrics.map(m => m.anchors_dragged)),
    drafts_edited: median(metrics.map(m => m.drafts_edited)),
    drafts_discarded: median(metrics.map(m => m.drafts_discarded)),
    touchless_count: metrics.filter(m => m.touchless).length,
  };
}

function median(values) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
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

function evaluateChecks(result) {
  const failures = [];
  if (result.draftCount !== EXPECTED_DRAFT_COUNT) {
    failures.push(`Expected ${EXPECTED_DRAFT_COUNT} drafts, got ${result.draftCount}.`);
  }
  if (result.validationStatus === 'fail') {
    failures.push(`Validation failed: ${result.validationErrors.join('; ') || 'unknown error'}`);
  }
  if (result.validationErrors.length) {
    failures.push(`Validation returned errors: ${result.validationErrors.join('; ')}`);
  }
  if (result.highConfidenceCount < MIN_HIGH_CONFIDENCE) {
    failures.push(`Expected at least ${MIN_HIGH_CONFIDENCE} high-confidence draft(s), got ${result.highConfidenceCount}.`);
  }
  if (result.reviewOnlyApproved.length) {
    failures.push(`Review-only drafts were approved: ${result.reviewOnlyApproved.join(', ')}.`);
  }
  if (result.approvedCount <= 0) {
    failures.push('No drawable drafts were approved.');
  }
  if (!result.appliedOk) {
    failures.push('Apply Approved Lines returned false.');
  }
  if (result.appliedAutoAnnotationCount !== result.approvedCount) {
    failures.push(`Applied annotation count ${result.appliedAutoAnnotationCount} does not match approved count ${result.approvedCount}.`);
  }
  if (result.missingMetadata.length) {
    failures.push(`Applied annotations missing metadata: ${result.missingMetadata.join('; ')}`);
  }
  // Reopen handoff: a saved project that contains applied lines opens in
  // Manual Mode, ready to edit (Manual Mode re-enable, TD decision 2).
  if (result.reopenedAppMode !== 'manual') {
    failures.push(`Expected reopened project (applied lines) to open in Manual Mode, got ${result.reopenedAppMode}.`);
  }
  if (result.reopenedDraftCount !== 0) {
    failures.push(`Expected no drafts after reopen, got ${result.reopenedDraftCount}.`);
  }
  if (result.reopenedAutoAnnotationCount !== result.appliedAutoAnnotationCount) {
    failures.push(`Reopened auto annotation count ${result.reopenedAutoAnnotationCount} does not match saved count ${result.appliedAutoAnnotationCount}.`);
  }
  if (result.reopenedMissingMetadata.length) {
    failures.push(`Reopened annotations missing metadata: ${result.reopenedMissingMetadata.join('; ')}`);
  }
  // CV debug payload must travel with the runAutoOnDataUrl result so the
  // detector's intermediate state stays inspectable as we tune detection.
  const cv = result.cvDebug || {};
  if (!cv.present) {
    failures.push('CV debug: payload missing after runAutoOnDataUrl({cvDebug:true}).');
  } else {
    if (!cv.hasDetectionParams) failures.push('CV debug: detectionParams not surfaced.');
    if (!cv.hasStageTimings) failures.push('CV debug: stage timings not surfaced.');
    if (cv.viewBoxCount <= 0) failures.push('CV debug: no view boxes captured.');
  }
  const cvExp = result.cvExport;
  if (!cvExp) {
    failures.push('CV debug: exportDebug() returned null.');
  } else {
    if (!(cvExp.anchorCount > 0)) failures.push('CV debug export: no anchors recorded.');
    if (!cvExp.hasLearnedParams) failures.push('CV debug export: learned params missing.');
    if (!cvExp.hasThresholds) failures.push('CV debug export: threshold values missing.');
    if (!cvExp.hasDetectionParams) failures.push('CV debug export: detectionParams missing.');
  }
  return failures;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
