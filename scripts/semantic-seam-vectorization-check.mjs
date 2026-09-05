#!/usr/bin/env node
// US-125 / ADR 0092-0098: model, authority, lifecycle and persistence proof
// for one canonical Seam Path partitioned into semantic Treatment Runs.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let server, chrome, userDataDir, passed = 0;
const cleanup = [];
const check = (ok, message) => { if (!ok) throw new Error(message); passed += 1; };

function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function directedPolylineDistance(source, target) {
  let maximum = 0;
  for (const point of source) {
    let nearest = Infinity;
    for (let index = 1; index < target.length; index += 1) {
      nearest = Math.min(nearest, pointToSegmentDistance(point, target[index - 1], target[index]));
    }
    maximum = Math.max(maximum, nearest);
  }
  return maximum;
}

function symmetricPolylineDistance(left, right) {
  return Math.max(directedPolylineDistance(left, right), directedPolylineDistance(right, left));
}

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const port = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'semantic-seam-vectorization-check-'));
  cleanup.push(() => rm(userDataDir, { recursive: true, force: true }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--window-size=1366,900',
    `${started.baseUrl}/index.html?semanticseam=${Date.now()}`,
  ]);
  cleanup.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(port);
  const s = await session(port);
  await s.waitFor('window.__braAutoModeDebug && document.getElementById("modeManualBtn")', 8000);

  const commands = await s.eval(`(() => {
    const ids = window.__braAutoModeDebug.commands.list().map(command => command.id);
    return {
      breakTreatment: ids.includes('board.treatment.break'),
      removeBreak: ids.includes('board.treatment.remove-break'),
      oneNeedle: ids.includes('board.treatment.1ndl'),
      twoNeedle: ids.includes('board.treatment.2ndl'),
    };
  })()`);
  check(Object.values(commands).every(Boolean), `all four semantic treatment commands must be registered, got ${JSON.stringify(commands)}`);

  const fixture = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    const baseTreatment = {
      name: '1NDL fixture', semantic: { needleCount: 1 },
      layers: [{ id: 'fixture-layer', pattern: 'solid', offset: 0, width: 1.6, color: 'black', spacing: 10, amplitude: 4 }],
    };
    const annotation = d.seamPath.addTestAnnotation({
      id: 12501, type: 'curved', start: { x: 260, y: 390 }, end: { x: 760, y: 390 },
      control1: { x: 380, y: 150 }, control2: { x: 625, y: 625 },
      points: [], lineTreatment: baseTreatment,
    });
    const eligibility = d.seamPath.eligibility(annotation.id);
    const beforeSample = d.seamPath.sample(annotation.id);
    const promoted = d.seamPath.promote(annotation.id);
    return {
      id: annotation.id, eligibility, beforeSample, promoted,
      measurementIds: d.getMeasurementAnnIds(),
    };
  })()`);
  check(fixture.eligibility.ok === true, `one selected treatment-bearing manual curve must be eligible, got ${JSON.stringify(fixture.eligibility)}`);
  check(fixture.promoted.purpose === 'sketch-element' && !fixture.measurementIds.includes(fixture.id),
    'a promoted seam must remain construction geometry and never leak into measurement rows');
  check(fixture.promoted.seamPath.version === 'seam-path/1', 'promotion must write the versioned Seam Path contract');
  check(fixture.promoted.seamPath.treatmentRuns.length === 1, 'legacy whole-path treatment must migrate to one exhaustive Treatment Run');
  check(fixture.promoted.seamPath.treatmentRuns[0].startNodeId === fixture.promoted.seamPath.startNodeId
    && fixture.promoted.seamPath.treatmentRuns[0].endNodeId === fixture.promoted.seamPath.endNodeId,
  'the implicit legacy run must own the complete start-to-end interval');
  check(new Set([fixture.promoted.seamPath.startNodeId, fixture.promoted.seamPath.endNodeId]).size === 2,
    'Seam Path endpoints must receive unique stable node ids');

  const split = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const out = d.seamPath.insertBreak(12501, 0, 0.43);
    return { ...out, afterSample: d.seamPath.sample(12501) };
  })()`);
  check(split.result.status === 'inserted', `open-path Treatment Break must insert, got ${JSON.stringify(split.result)}`);
  check(split.annotation.points.length === 1 && !!split.result.nodeId, 'the break must create exactly one stable interior node');
  check(split.annotation.seamPath.treatmentRuns.length === 2, 'one open-path boundary must create exactly two Treatment Runs');
  check(split.annotation.seamPath.treatmentRuns[0].endNodeId === split.result.nodeId
    && split.annotation.seamPath.treatmentRuns[1].startNodeId === split.result.nodeId,
  'adjacent Treatment Runs must share the exact same boundary node');
  check(split.selectionPart === `treatmentRun:${split.annotation.seamPath.treatmentRuns[1].id}`,
    'Break Treatment must select the following run');
  const splitDistance = symmetricPolylineDistance(fixture.beforeSample, split.afterSample);
  check(splitDistance < 0.01, `exact cubic subdivision must preserve represented geometry; distance=${splitDistance}`);

  const treatmentEdit = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const approved = d.seamPath.setApproval(12501, true);
    const following = approved.seamPath.treatmentRuns[1];
    const before = {
      geometry: approved.seamPath.geometryFingerprint,
      technical: approved.seamPath.technicalContentFingerprint,
      history: d.seamPath.historyDepth(),
    };
    const applied = d.seamPath.applyPreset(12501, following.id, 'builtin-2ndl');
    const changed = d.getAnnotations().find(annotation => annotation.id === 12501);
    return { applied, before, changed, followingId: following.id, history: d.seamPath.historyDepth() };
  })()`);
  const editedRun = treatmentEdit.changed.seamPath.treatmentRuns.find(run => run.id === treatmentEdit.followingId);
  check(treatmentEdit.applied === true, 'the governed 2NDL preset must apply to one selected Treatment Run');
  check(treatmentEdit.changed.seamPath.geometryFingerprint === treatmentEdit.before.geometry,
    'a real Treatment edit must preserve geometryFingerprint');
  check(treatmentEdit.changed.seamPath.technicalContentFingerprint !== treatmentEdit.before.technical,
    'a real Treatment edit must change technicalContentFingerprint');
  check(treatmentEdit.changed.tdApproved === false && treatmentEdit.changed.tdApprovalRequired === true
    && treatmentEdit.changed.approvedAt === null,
  'a real Treatment edit must invalidate prior TD approval');
  check(editedRun.treatment.semantic.needleCount === 2
    && editedRun.treatment.semantic.needleGauge.status === 'tbc',
  '2NDL must carry two-needle semantics with Needle Gauge explicitly TBC');
  check(editedRun.treatment.displaySpacing === 8
    && editedRun.treatment.layers.map(layer => layer.offset).join(',') === '-4,4',
  '2NDL display rail spacing must remain a separate deterministic presentation value');
  check(treatmentEdit.history === treatmentEdit.before.history + 1,
    'one real run treatment change must produce exactly one history entry');

  const noop = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const approved = d.seamPath.setApproval(12501, true);
    const run = approved.seamPath.treatmentRuns[1];
    const before = {
      geometry: approved.seamPath.geometryFingerprint,
      technical: approved.seamPath.technicalContentFingerprint,
      history: d.seamPath.historyDepth(),
    };
    d.seamPath.applyPreset(12501, run.id, 'builtin-2ndl');
    const after = d.getAnnotations().find(annotation => annotation.id === 12501);
    return { before, after, history: d.seamPath.historyDepth() };
  })()`);
  check(noop.history === noop.before.history, 'reapplying identical normalized 2NDL content must not create history');
  check(noop.after.tdApproved === true && noop.after.approvedAt === 'test-approved',
    'a normalized treatment no-op must preserve TD approval');
  check(noop.after.seamPath.geometryFingerprint === noop.before.geometry
      && noop.after.seamPath.technicalContentFingerprint === noop.before.technical,
  'a normalized treatment no-op must preserve both fingerprints');

  const pasted = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    d.selectAnnotation(12501);
    document.getElementById('copyLineBtn').click();
    document.getElementById('pasteLineBtn').click();
    const source = d.getAnnotations().find(annotation => annotation.id === 12501);
    const copy = d.getAnnotations().find(annotation => annotation.id !== 12501 && annotation.seamPath);
    return { source, copy };
  })()`);
  check(!!pasted.copy && pasted.copy.seamPath.treatmentRuns.length === pasted.source.seamPath.treatmentRuns.length,
    'copy/paste must preserve the Treatment Run partition on a fresh annotation');
  check(pasted.copy.seamPath.treatmentRuns.map(run => run.treatment.semantic.needleCount).join(',')
      === pasted.source.seamPath.treatmentRuns.map(run => run.treatment.semantic.needleCount).join(','),
    'copy/paste must preserve per-run technical meaning');
  check(pasted.copy.seamPath.startNodeId !== pasted.source.seamPath.startNodeId
      && pasted.copy.seamPath.treatmentRuns.every((run, index) => run.id !== pasted.source.seamPath.treatmentRuns[index].id),
    'a pasted Seam Path must receive fresh node/run identity rather than aliasing the source');
  check(pasted.copy.seamPath.detectionTrace === null && pasted.copy.seamPath.fidelityReceipt === null,
    'a pasted path must not claim detector evidence belonging to its source');

  const lifecycle = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const before = d.getAnnotations().find(annotation => annotation.id === 12501);
    const stableNodeId = before.points[0].nodeId;
    const stableRunIds = before.seamPath.treatmentRuns.map(run => run.id);
    const moved = d.seamPath.movePoint(12501, 0, 18, -11);
    const afterMove = d.getAnnotations().find(annotation => annotation.id === 12501);
    await d.seamPath.undo();
    const afterUndo = d.getAnnotations().find(annotation => annotation.id === 12501);
    await d.seamPath.redo();
    const afterRedo = d.getAnnotations().find(annotation => annotation.id === 12501);
    const project = d.exportProject();
    await d.loadProject(project);
    const afterLoad = d.getAnnotations().find(annotation => annotation.id === 12501);
    return { stableNodeId, stableRunIds, moved, afterMove, afterUndo, afterRedo, afterLoad };
  })()`);
  check(lifecycle.afterMove.points[0].nodeId === lifecycle.stableNodeId
    && lifecycle.afterRedo.points[0].nodeId === lifecycle.stableNodeId
    && lifecycle.afterLoad.points[0].nodeId === lifecycle.stableNodeId,
  'shared boundary node identity must survive drag, Redo and Save/Open');
  check(lifecycle.afterMove.seamPath.geometryFingerprint !== noop.after.seamPath.geometryFingerprint,
    'moving the shared path node must change geometryFingerprint');
  check(lifecycle.afterUndo.points[0].point.x === noop.after.points[0].point.x
    && lifecycle.afterUndo.points[0].point.y === noop.after.points[0].point.y,
  'Undo must restore the exact pre-drag shared-node coordinates');
  check(lifecycle.afterRedo.points[0].point.x === lifecycle.afterMove.points[0].point.x
    && lifecycle.afterRedo.points[0].point.y === lifecycle.afterMove.points[0].point.y,
  'Redo must restore the moved shared-node coordinates');
  check(JSON.stringify(lifecycle.afterLoad.seamPath.treatmentRuns.map(run => run.id)) === JSON.stringify(lifecycle.stableRunIds),
    'Save/Open must preserve Treatment Run ids and ordering');
  check(lifecycle.afterLoad.seamPath.technicalContentFingerprint === lifecycle.afterRedo.seamPath.technicalContentFingerprint,
    'Save/Open must preserve technical content fingerprint exactly');

  const removal = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const before = d.getAnnotations().find(annotation => annotation.id === 12501);
    const point = JSON.parse(JSON.stringify(before.points[0]));
    const followingTreatment = JSON.parse(JSON.stringify(before.seamPath.treatmentRuns[1].treatment));
    const removed = d.seamPath.removeBreak(12501, 0, 'following');
    const after = d.getAnnotations().find(annotation => annotation.id === 12501);
    return { removed, point, followingTreatment, after };
  })()`);
  check(removal.removed === true && removal.after.seamPath.treatmentRuns.length === 1,
    'Remove Treatment Break must merge two adjacent ownership intervals');
  check(removal.after.points.length === 1 && removal.after.points[0].nodeId === removal.point.nodeId
    && JSON.stringify(removal.after.points[0].point) === JSON.stringify(removal.point.point),
  'Remove Treatment Break must keep the path node and its geometry unchanged');
  check(removal.after.seamPath.treatmentRuns[0].treatment.semantic.needleCount === 2
    && JSON.stringify(removal.after.seamPath.treatmentRuns[0].treatment) === JSON.stringify(removal.followingTreatment),
  'an explicit FOLLOWING choice must retain the following 2NDL Treatment');

  const exclusions = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    const treatment = { name: '1NDL fixture', semantic: { needleCount: 1 }, layers: [
      { id: 'x', pattern: 'solid', offset: 0, width: 1.6, color: 'black', spacing: 10, amplitude: 4 },
    ] };
    const pom = d.seamPath.addTestAnnotation({ id: 12502, type: 'straight', start: { x: 100, y: 100 }, end: { x: 200, y: 100 }, text: '8', lineTreatment: treatment });
    const pomEligibility = d.seamPath.eligibility(pom.id);
    const member = d.seamPath.addTestAnnotation({ id: 12503, type: 'straight', start: { x: 100, y: 140 }, end: { x: 200, y: 140 }, templateGroupId: 'template-fixture', lineTreatment: treatment });
    const templateEligibility = d.seamPath.eligibility(member.id);
    return { pomEligibility, templateEligibility };
  })()`);
  check(exclusions.pomEligibility.ok === false && /POM/i.test(exclusions.pomEligibility.reason),
    `a manually labelled POM must be excluded from Treatment Break, got ${JSON.stringify(exclusions.pomEligibility)}`);
  check(exclusions.templateEligibility.ok === false && /Template/i.test(exclusions.templateEligibility.reason),
    `a grouped Template member must be excluded from Treatment Break, got ${JSON.stringify(exclusions.templateEligibility)}`);

  const equivalentMerge = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const treatment = { name: 'same', semantic: { needleCount: 1 }, layers: [
      { id: 'same-layer', pattern: 'solid', offset: 0, width: 1.6, color: 'black', spacing: 10, amplitude: 4 },
    ] };
    const ann = d.seamPath.addTestAnnotation({ id: 12504, type: 'straight', start: { x: 100, y: 220 }, end: { x: 300, y: 220 }, lineTreatment: treatment });
    d.seamPath.promote(ann.id);
    const split = d.seamPath.insertBreak(ann.id, 0, 0.5);
    let promptCalled = false;
    window.prompt = () => { promptCalled = true; return null; };
    const removed = d.seamPath.removeBreak(ann.id, 0);
    const after = d.getAnnotations().find(item => item.id === ann.id);
    return { split, promptCalled, removed, after };
  })()`);
  check(equivalentMerge.removed === true && equivalentMerge.promptCalled === false,
    'equivalent adjacent Treatments must merge directly without asking the TD to choose a side');
  check(equivalentMerge.after.points.length === 1 && equivalentMerge.after.seamPath.treatmentRuns.length === 1,
    'equivalent-treatment merge must keep its geometry point while removing only the ownership boundary');

  const malformed = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const project = d.exportProject();
    const ann = project.state.annotations.find(item => item.id === 12504);
    ann.seamPath.treatmentRuns = [{
      id: 'bad-run', startNodeId: ann.seamPath.endNodeId,
      endNodeId: ann.seamPath.startNodeId, wrap: false,
      treatment: ann.lineTreatment,
    }];
    await d.loadProject(project);
    return d.getAnnotations().find(item => item.id === 12504);
  })()`);
  check(malformed.seamPath.validationStatus === 'review'
      && malformed.seamPath.validationReasons.includes('invalid_or_non_exhaustive_treatment_runs'),
    'malformed or reversed run ownership must normalize to Review rather than guessed technical meaning');
  check(malformed.seamPath.treatmentRuns.length === 1
      && malformed.seamPath.treatmentRuns[0].startNodeId === malformed.seamPath.startNodeId
      && malformed.seamPath.treatmentRuns[0].endNodeId === malformed.seamPath.endNodeId,
    'invalid run data must fall back deterministically to one exhaustive full-path interval');

  const errors = await s.eval('window.__semanticSeamErrors || []');
  check(errors.length === 0, 'browser console errors: ' + errors.join(' | '));
  await s.close();
  console.log(`PASS  semantic-seam-vectorization-check   ${passed}/${passed} assertions ok`);
}

async function session(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
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
    const messageId = ++id;
    pending.set(messageId, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  await cdp('Runtime.enable');
  await cdp('Runtime.evaluate', {
    expression: `window.__semanticSeamErrors=[];addEventListener('error',event=>window.__semanticSeamErrors.push(String(event.message||event.error)))`,
  });
  const evalJs = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return {
    eval: evalJs,
    waitFor: async (query, milliseconds) => {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) {
        try { if (await evalJs(query)) return; } catch { /* retry */ }
        await sleep(80);
      }
      throw new Error('timeout ' + query);
    },
    close: () => ws.close(),
  };
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitForCdp(port) {
  for (let index = 0; index < 100; index += 1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch { /* retry */ }
    await sleep(80);
  }
  throw new Error('CDP did not start');
}
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

try { await main(); } catch (error) { process.exitCode = 1; console.error('FAIL', error.message); }
finally { for (const task of cleanup.reverse()) try { await task(); } catch { /* best effort */ } }
