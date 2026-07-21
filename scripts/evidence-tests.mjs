#!/usr/bin/env node
// Headless tests for Style Evidence learning (Phase 1 + Phase 2).
//
// Drives the live page via CDP — same harness shape as learning-tests.mjs —
// and exercises window.__braAutoModeDebug.styleEvidence:
//   1. Empty store summary is well-formed.
//   2. add() persists, list() returns newest-first, forget() removes.
//   3. After Auto Mode + apply + simulated TD edit, collectCandidates returns
//      a record with normalized coordinates and commitCandidates persists it.
//   4. A TD-deleted Auto POM records confirmed-absent evidence for the style.
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
  userDataDir = await mkdtemp(path.join(tmpdir(), 'bra-evidence-tests-'));
  const targetUrl = `${baseUrl}/index.html?evidenceTests=${Date.now()}`;

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
  const result = await runEvidenceTests(cdp, demoImage);
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
      const ok = await evaluate(cdp, '!!(window.__braAutoModeDebug && window.__braAutoModeDebug.styleEvidence)');
      if (ok) return;
    } catch (e) { /* context mid-navigation — retry */ }
    await sleep(150);
  }
  throw new Error('window.__braAutoModeDebug.styleEvidence was not exposed within 15s');
}

async function runEvidenceTests(cdp, imagePath) {
  return await evaluate(cdp, `
    (async () => {
      const debug = window.__braAutoModeDebug;
      const E = debug.styleEvidence;
      const M = debug.meaning;
      const tests = [];

      function record(name, pass, reason, details) {
        tests.push({ name, pass, reason: pass ? null : (reason || 'failed'), details });
      }

      // --- TEST 1: Empty store summary is well-formed -------------------
      try {
        E.clearAll();
        M.setStyleId('TEST-STYLE');
        const summary = E.summarize();
        const ok = summary
          && summary.styleId === 'TEST-STYLE'
          && summary.totalRecords === 0
          && summary.confirmedCount === 0
          && Array.isArray(summary.rows)
          && summary.rows.length === 0;
        record('Empty evidence store summary is well-formed', ok,
          'summary=' + JSON.stringify(summary), { summary });
      } catch (e) {
        record('Empty evidence store summary is well-formed', false, String(e && e.message || e));
      }

      // --- TEST 2: add/list/forget round trip ---------------------------
      try {
        E.clearAll();
        M.setStyleId('TEST-STYLE');
        const recA = E.add('TEST-STYLE', {
          id: 'ev_test_a',
          pom: '9',
          meaningId: 'cup-height',
          viewRole: 'front_outer',
          source: 'td-edited-auto-line',
          tdStatus: 'confirmed',
          line: { type: 'straight', start: { x: 0.21, y: 0.56 }, end: { x: 0.46, y: 0.47 } },
        });
        const recB = E.add('TEST-STYLE', {
          id: 'ev_test_b',
          pom: '1',
          meaningId: 'band-width',
          viewRole: 'front_outer',
          source: 'td-edited-auto-line',
          tdStatus: 'confirmed',
          line: { type: 'straight', start: { x: 0.10, y: 0.91 }, end: { x: 0.93, y: 0.91 } },
        });
        const listed = E.list('TEST-STYLE');
        const summary = E.summarize('TEST-STYLE');
        const forgotten = E.forget('TEST-STYLE', 'ev_test_b');
        const listedAfter = E.list('TEST-STYLE');
        const ok =
          recA && recA.id === 'ev_test_a' &&
          recB && recB.id === 'ev_test_b' &&
          listed.length === 2 &&
          summary.totalRecords === 2 &&
          summary.confirmedCount === 2 &&
          summary.rows.length === 2 &&
          forgotten === true &&
          listedAfter.length === 1 &&
          listedAfter[0].id === 'ev_test_a';
        record('Evidence add/list/forget round trip', ok,
          'listed=' + listed.length + ' summary=' + JSON.stringify(summary) + ' after=' + listedAfter.length,
          { listed, summary, forgotten, listedAfter });
      } catch (e) {
        record('Evidence add/list/forget round trip', false, String(e && e.message || e));
      }

      // --- Shared setup for capture test: load demo image and Auto run ---
      let loadedDrafts = null;
      let loadedDataURL = null;
      let loadErr = null;
      try {
        const response = await fetch(${JSON.stringify(imagePath)} + '?et=' + Date.now(), { cache: 'no-store' });
        if (!response.ok) throw new Error('fetch ' + response.status);
        const blob = await response.blob();
        const dataURL = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('FileReader failed'));
          reader.readAsDataURL(blob);
        });
        loadedDataURL = dataURL;
        await debug.runAutoOnDataUrl(dataURL);
        loadedDrafts = debug.getDrafts();
      } catch (e) {
        loadErr = String(e && e.message || e);
      }

      // --- TEST 3: TD-edited applied auto line becomes evidence ---------
      try {
        if (!loadedDrafts || !loadedDrafts.length) {
          throw new Error('no drafts loaded; loadErr=' + loadErr);
        }
        E.clearAll();
        M.setStyleId('CAPTURE-STYLE');
        debug.approveDrawableDrafts();
        const applied = debug.applyApprovedDrafts();
        if (!applied) throw new Error('applyApprovedDrafts failed');
        // Find an applied auto line on the project (POM 1 = band width).
        const annotations = debug.getAnnotations();
        const pom1 = annotations.find(a => a.auto === true && Number(a.seq) === 1);
        if (!pom1) throw new Error('POM 1 applied annotation missing');
        const images = debug.getImages();
        const image = images && images.find(im => im.id === pom1.sourceImageId);
        if (!image) throw new Error('source image missing');
        // Patch the live annotation to simulate a TD edit (shifts the
        // start point ~2% of image width to the right and marks tdEdited).
        E.simulateTdEdit(pom1.id, {
          start: { x: pom1.start.x + image.width * 0.02, y: pom1.start.y },
        });

        const candidates = E.collectCandidates('CAPTURE-STYLE');
        const pom1Cand = candidates.find(c => c.pom === '1');
        const written = E.commitCandidates('CAPTURE-STYLE', candidates);
        const summary = E.summarize('CAPTURE-STYLE');
        const stored = E.list('CAPTURE-STYLE').find(r => r.pom === '1');

        const ok = candidates.length > 0
          && !!pom1Cand
          && pom1Cand.line
          && Number.isFinite(pom1Cand.line.start.x)
          && pom1Cand.line.start.x >= 0 && pom1Cand.line.start.x <= 1
          && pom1Cand.line.end.x   >= 0 && pom1Cand.line.end.x   <= 1
          && pom1Cand.source === 'td-edited-auto-line'
          && pom1Cand.tdStatus === 'confirmed'
          && written === candidates.length
          && summary.totalRecords === candidates.length
          && !!stored
          && stored.line
          && Math.abs(stored.line.start.x - pom1Cand.line.start.x) < 1e-9;

        record('TD-edited applied auto line becomes normalized evidence', ok,
          'candidates=' + candidates.length + ' written=' + written
          + ' summaryTotal=' + summary.totalRecords
          + ' pom1Cand.line.start.x=' + (pom1Cand && pom1Cand.line && pom1Cand.line.start.x),
          { candidates, summary, stored });
      } catch (e) {
        record('TD-edited applied auto line becomes normalized evidence', false, String(e && e.message || e));
      }

      // --- TEST 4: Manual confirmed POM line becomes evidence -----------
      try {
        if (!loadedDrafts || !loadedDrafts.length) {
          throw new Error('no drafts loaded; loadErr=' + loadErr);
        }
        E.clearAll();
        M.clearAll();
        M.setStyleId('MANUAL-STYLE');
        // Use a POM whose anchor pair is geometrically close to the line —
        // applyMeaningSample has a 50%-of-image guardrail that rejects
        // mislabeled lines, so we re-use the POM 9 draft's own endpoints
        // here to keep the test inside the guardrail.
        const refDraft = loadedDrafts.find(d => String(d.seq || d.text) === '9')
          || loadedDrafts.find(d => String(d.seq || d.text) === '1');
        if (!refDraft || !refDraft.start || !refDraft.end) {
          throw new Error('reference draft missing for manual ann');
        }
        const start = { x: refDraft.start.x, y: refDraft.start.y };
        const end   = { x: refDraft.end.x,   y: refDraft.end.y };
        const manualAnn = {
          id: 'manual-9-test',
          type: 'line',
          text: '9',
          color: 'red',
          style: 'solid',
          width: 2,
          arrows: 'double',
          start,
          end,
          label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
        };
        const commitRes = M.commitChoice(manualAnn, 'cup-height');
        // commitChoice mutates the same ann object passed in (stamping
        // learnSampleHash + learnMeaningId), so we can hand the live
        // object straight to the project annotations list.
        E.pushAnnotation(manualAnn);

        const candidates = E.collectCandidates('MANUAL-STYLE');
        const manualCand = candidates.find(c => c.pom === '9' && c.source === 'manual-confirmed-line');
        const written = E.commitCandidates('MANUAL-STYLE', candidates);
        const stored = E.list('MANUAL-STYLE').find(r => r.pom === '9');

        const ok = commitRes && commitRes.status === 'recorded'
          && !!manualCand
          && manualCand.meaningId === 'cup-height'
          && manualCand.line
          && Number.isFinite(manualCand.line.start.x)
          && manualCand.line.start.x >= 0 && manualCand.line.start.x <= 1
          && manualCand.line.end.x   >= 0 && manualCand.line.end.x   <= 1
          && manualCand.tdStatus === 'confirmed'
          && written >= 1
          && !!stored
          && stored.source === 'manual-confirmed-line';

        record('Manual confirmed POM line becomes normalized evidence', ok,
          'commitRes=' + JSON.stringify(commitRes)
          + ' candidates=' + candidates.length
          + ' written=' + written
          + ' stored.source=' + (stored && stored.source),
          { commitRes, candidates, stored });
      } catch (e) {
        record('Manual confirmed POM line becomes normalized evidence', false, String(e && e.message || e));
      }

      // --- TEST 5: TD-deleted Auto POM becomes absent evidence ----------
      try {
        const images = debug.getImages();
        const image = images && images[0];
        if (!image) throw new Error('source image missing for absent test');
        E.clearAll();
        M.setStyleId('ABSENT-POM7-STYLE');

        // Delete the REAL applied POM 7 auto line. TEST 3 applied the
        // drawable drafts, and since the arc tier (US-014 / ADR 0022)
        // POM 7 drafts DRAWABLE on demo1 — so a POM 7 line is already on
        // the board, and the absence guard rightly refuses "POM 7 is
        // absent" while any POM 7 line remains. Deleting the applied line
        // IS the scenario under test. Fall back to a synthetic POM 7 ann
        // only when no applied line exists (pre-arc-tier detector).
        let ann = debug.getAnnotations().find(a => a && a.auto === true && Number(a.seq) === 7);
        if (!ann) {
          ann = {
            id: 'auto-absent-pom7-test',
            type: 'line',
            seq: 7,
            text: null,
            auto: true,
            sourceMode: 'auto-mode',
            sourceImageId: image.id,
            viewRole: 'front_outer',
            drawability: 'DRAWABLE',
            color: 'red',
            style: 'solid',
            width: 2,
            arrows: 'double',
            start: { x: image.x + image.width * 0.48, y: image.y + image.height * 0.72 },
            end:   { x: image.x + image.width * 0.48, y: image.y + image.height * 0.86 },
            label: { x: image.x + image.width * 0.50, y: image.y + image.height * 0.79 },
          };
          E.pushAnnotation(ann);
        }
        const deleted = E.simulateTdDelete(ann.id);
        const candidates = E.collectCandidates('ABSENT-POM7-STYLE');
        const absentCand = candidates.find(c =>
          c.pom === '7'
          && c.source === 'td-deleted-auto-line'
          && c.tdStatus === 'absent-confirmed'
        );
        const written = E.commitCandidates('ABSENT-POM7-STYLE', candidates);
        const summary = E.summarize('ABSENT-POM7-STYLE');
        const stored = E.list('ABSENT-POM7-STYLE').find(r => r.pom === '7');
        const candidatesAfterCommit = E.collectCandidates('ABSENT-POM7-STYLE');
        const nextDrafts = E.applyAbsenceToDrafts([
          { id: 'draft-7', seq: 7, drawability: 'DRAWABLE', start: { x: 1, y: 1 }, end: { x: 1, y: 2 } },
          { id: 'draft-8', seq: 8, drawability: 'DRAWABLE', start: { x: 2, y: 1 }, end: { x: 2, y: 2 } },
        ]);
        const nextPom7 = nextDrafts.find(d => String(d.seq) === '7');
        const nextPom8 = nextDrafts.find(d => String(d.seq) === '8');

        const ok = !!deleted
          && !!absentCand
          && absentCand.line == null
          && absentCand.rejectedLine
          && absentCand.meaningId === 'cradle-height-bottom-cup'
          && written >= 1
          && summary.absentCount === 1
          && summary.rows.some(row => row.pom === '7' && row.status === 'absent-confirmed')
          && !!stored
          && stored.tdStatus === 'absent-confirmed'
          && stored.source === 'td-deleted-auto-line'
          && candidatesAfterCommit.filter(c => c.source === 'td-deleted-auto-line').length === 0
          && !!nextPom7
          && nextPom7.drawability === 'REVIEW_ONLY'
          && nextPom7.styleEvidenceStatus === 'absent-confirmed'
          && !!nextPom8
          && nextPom8.drawability === 'DRAWABLE';

        record('TD-deleted Auto POM becomes confirmed-absent style evidence', ok,
          'deleted=' + !!deleted
          + ' absentCand=' + !!absentCand
          + ' written=' + written
          + ' absentCount=' + (summary && summary.absentCount)
          + ' afterCommit=' + candidatesAfterCommit.length
          + ' nextPom7=' + (nextPom7 && nextPom7.drawability),
          { deleted, candidates, absentCand, summary, stored, candidatesAfterCommit, nextPom7, nextPom8 });
      } catch (e) {
        record('TD-deleted Auto POM becomes confirmed-absent style evidence', false, String(e && e.message || e));
      }

      // --- TEST 6: Confirmed evidence softly pulls drafts toward median ---
      try {
        const images = debug.getImages();
        const image = images && images[0];
        if (!image) throw new Error('source image missing for confirmed-reuse test');
        E.clearAll();
        M.setStyleId('REUSE-STYLE');

        // Two confirmed POM 1 records at slightly different normalized
        // positions — the median is what should drive the blend.
        E.add('REUSE-STYLE', {
          id: 'ev_reuse_1a',
          pom: '1',
          meaningId: 'band-width',
          viewRole: 'front_outer',
          source: 'td-edited-auto-line',
          tdStatus: 'confirmed',
          line: { type: 'straight', start: { x: 0.10, y: 0.90 }, end: { x: 0.90, y: 0.90 } },
        });
        E.add('REUSE-STYLE', {
          id: 'ev_reuse_1b',
          pom: '1',
          meaningId: 'band-width',
          viewRole: 'front_outer',
          source: 'td-edited-auto-line',
          tdStatus: 'confirmed',
          line: { type: 'straight', start: { x: 0.12, y: 0.92 }, end: { x: 0.88, y: 0.92 } },
        });

        const medians = E.confirmedMedians('REUSE-STYLE');
        // Synthetic draft for POM 1 placed off-target so we can measure
        // the pull. World coords from the image bbox.
        const draftStartWorld = { x: image.x + image.width * 0.20, y: image.y + image.height * 0.80 };
        const draftEndWorld   = { x: image.x + image.width * 0.80, y: image.y + image.height * 0.80 };
        // Expected median (start.x=0.11, y=0.91, end.x=0.89, y=0.91) in world coords.
        const evStartWorld = { x: image.x + image.width * 0.11, y: image.y + image.height * 0.91 };
        const evEndWorld   = { x: image.x + image.width * 0.89, y: image.y + image.height * 0.91 };
        const blend = 0.4;
        const expStart = {
          x: draftStartWorld.x * (1 - blend) + evStartWorld.x * blend,
          y: draftStartWorld.y * (1 - blend) + evStartWorld.y * blend,
        };
        const expEnd = {
          x: draftEndWorld.x * (1 - blend) + evEndWorld.x * blend,
          y: draftEndWorld.y * (1 - blend) + evEndWorld.y * blend,
        };

        const inputDrafts = [
          {
            id: 'draft-1', seq: 1, drawability: 'DRAWABLE', type: 'straight',
            confidence: 'medium',
            start: { x: draftStartWorld.x, y: draftStartWorld.y },
            end:   { x: draftEndWorld.x,   y: draftEndWorld.y },
          },
          // POM 9 has no confirmed evidence — should be untouched.
          {
            id: 'draft-9', seq: 9, drawability: 'DRAWABLE', type: 'straight',
            confidence: 'medium',
            start: { x: image.x + image.width * 0.3, y: image.y + image.height * 0.5 },
            end:   { x: image.x + image.width * 0.7, y: image.y + image.height * 0.5 },
          },
        ];
        const nudged = E.applyConfirmedToDrafts(inputDrafts, image);
        const pom1 = nudged.find(d => d.seq === 1);
        const pom9 = nudged.find(d => d.seq === 9);

        const closeEnough = (a, b) => Math.abs(a - b) < 1e-3;
        const ok =
          !!medians['1']
          && Math.abs(medians['1'].startNorm.x - 0.11) < 1e-9
          && Math.abs(medians['1'].endNorm.x   - 0.89) < 1e-9
          && medians['1'].sampleCount === 2
          && !!pom1
          && closeEnough(pom1.start.x, expStart.x)
          && closeEnough(pom1.start.y, expStart.y)
          && closeEnough(pom1.end.x,   expEnd.x)
          && closeEnough(pom1.end.y,   expEnd.y)
          && pom1.styleEvidenceStatus === 'confirmed-prior'
          && pom1.styleEvidenceSamples === 2
          && pom1.confidence === 'high'
          && !!pom9
          && pom9.start.x === inputDrafts[1].start.x
          && pom9.end.x   === inputDrafts[1].end.x
          && pom9.styleEvidenceStatus !== 'confirmed-prior';

        record('Confirmed evidence softly pulls drafts toward median', ok,
          'medians[1]=' + JSON.stringify(medians['1'])
          + ' pom1.styleEvidenceStatus=' + (pom1 && pom1.styleEvidenceStatus)
          + ' pom1.start.x=' + (pom1 && pom1.start && pom1.start.x.toFixed(3))
          + ' expStart.x=' + expStart.x.toFixed(3),
          { medians, pom1, pom9, expStart, expEnd });
      } catch (e) {
        record('Confirmed evidence softly pulls drafts toward median', false, String(e && e.message || e));
      }

      // --- TEST 7: Far-away evidence is rejected (not applied) ----------
      try {
        const images = debug.getImages();
        const image = images && images[0];
        if (!image) throw new Error('source image missing for far-gap test');
        E.clearAll();
        M.setStyleId('FAR-EVIDENCE');

        // Evidence at the top-left corner; draft at the bottom-right. The
        // gap exceeds STYLE_EVIDENCE_REUSE_MAX_GAP (30% of max(w,h)), so
        // the blend must not run.
        E.add('FAR-EVIDENCE', {
          id: 'ev_far_1',
          pom: '1',
          meaningId: 'band-width',
          viewRole: 'front_outer',
          source: 'td-edited-auto-line',
          tdStatus: 'confirmed',
          line: { type: 'straight', start: { x: 0.02, y: 0.02 }, end: { x: 0.10, y: 0.02 } },
        });
        const draftStart = { x: image.x + image.width * 0.85, y: image.y + image.height * 0.85 };
        const draftEnd   = { x: image.x + image.width * 0.95, y: image.y + image.height * 0.85 };
        const input = [{
          id: 'draft-far-1', seq: 1, drawability: 'DRAWABLE', type: 'straight',
          confidence: 'medium',
          start: { x: draftStart.x, y: draftStart.y },
          end:   { x: draftEnd.x,   y: draftEnd.y },
        }];
        const nudged = E.applyConfirmedToDrafts(input, image);
        const pom1 = nudged.find(d => d.seq === 1);
        const ok = !!pom1
          && pom1.start.x === draftStart.x
          && pom1.end.x   === draftEnd.x
          && pom1.styleEvidenceStatus !== 'confirmed-prior';
        record('Far-away confirmed evidence is rejected', ok,
          'pom1.start.x=' + (pom1 && pom1.start.x.toFixed(3))
          + ' draftStart.x=' + draftStart.x.toFixed(3),
          { pom1 });
      } catch (e) {
        record('Far-away confirmed evidence is rejected', false, String(e && e.message || e));
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
