#!/usr/bin/env node
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
const EXPECTED_DRAFT_COUNT = 16;
const MIN_HIGH_CONFIDENCE = Number(process.env.AUTO_SMOKE_MIN_HIGH_CONFIDENCE || 1);

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
  await waitForDebugApi(cdp);
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
    close() {
      ws.close();
    },
  };
}

async function waitForDebugApi(cdp) {
  await evaluate(cdp, `
    new Promise((resolve, reject) => {
      let checks = 0;
      const timer = setInterval(() => {
        checks += 1;
        if (window.__braAutoModeDebug) {
          clearInterval(timer);
          resolve(true);
        } else if (checks > 100) {
          clearInterval(timer);
          reject(new Error('window.__braAutoModeDebug was not exposed'));
        }
      }, 100);
    })
  `);
}

async function runAutoModeSmoke(cdp, imagePath) {
  return await evaluate(cdp, `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const response = await fetch(${JSON.stringify(imagePath)} + '?smoke=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not fetch smoke image: ' + response.status);
      const blob = await response.blob();
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read smoke image'));
        reader.readAsDataURL(blob);
      });

      await debug.runAutoOnDataUrl(dataURL);
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
      };
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
  if (result.reopenedAppMode !== 'manual') {
    failures.push(`Expected reopened project to return to Manual Mode, got ${result.reopenedAppMode}.`);
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
