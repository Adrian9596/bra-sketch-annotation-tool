#!/usr/bin/env node
// US-125 browser proof: drive the real Stitches menu, keyboard and canvas
// pointer path for Treatment Break -> 2NDL -> run selection -> guarded delete.
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
  userDataDir = await mkdtemp(path.join(tmpdir(), 'treatment-runs-browser-check-'));
  cleanup.push(() => rm(userDataDir, { recursive: true, force: true }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--window-size=1366,900',
    `${started.baseUrl}/index.html?treatmentruns=${Date.now()}`,
  ]);
  cleanup.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(port);
  const s = await session(port);
  await s.waitFor('window.__braAutoModeDebug && document.getElementById("lineTreatmentBreakBtn")', 8000);

  const setup = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    const ann = d.seamPath.addTestAnnotation({
      id: 12511, type: 'straight', start: { x: 300, y: 360 }, end: { x: 700, y: 360 },
      lineTreatment: { name: '1NDL fixture', semantic: { needleCount: 1 }, layers: [
        { id: 'fixture-layer', pattern: 'solid', offset: 0, width: 1.6, color: 'black', spacing: 10, amplitude: 4 },
      ] },
    });
    d.seamPath.promote(ann.id);
    document.getElementById('stitchesBtn').click();
    const button = document.getElementById('lineTreatmentBreakBtn');
    return {
      menuOpen: !document.getElementById('stitchesMenu').hidden,
      visible: button.offsetParent !== null,
      enabled: !button.disabled,
      title: button.title,
    };
  })()`);
  check(setup.menuOpen && setup.visible && setup.enabled,
    `Break Treatment must be a reachable enabled Stitches action, got ${JSON.stringify(setup)}`);
  check(/continuous Seam Path/i.test(setup.title), 'Break Treatment tooltip must describe continuity rather than a hard cut');

  const escape = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('lineTreatmentBreakBtn').click();
    const armed = d.getState().tool;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const after = d.getState();
    return { armed, tool: after.tool, runCount: d.seamPath.get(12511).treatmentRuns.length };
  })()`);
  check(escape.armed === 'break-treatment' && escape.tool === 'select',
    `Escape must cancel the armed Break Treatment tool, got ${JSON.stringify(escape)}`);
  check(escape.runCount === 1, 'Escape before the click must be a model no-op');

  const split = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const clickWorld = (x, y) => {
      const view = d.getView();
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + x * view.zoom + view.panX;
      const clientY = rect.top + y * view.zoom + view.panY;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
    };
    document.getElementById('stitchesBtn').click();
    document.getElementById('lineTreatmentBreakBtn').click();
    clickWorld(500, 360);
    const ann = d.getAnnotations().find(item => item.id === 12511);
    return { tool: d.getState().tool, selection: d.getState().selection, ann };
  })()`);
  check(split.tool === 'break-treatment' && split.ann.seamPath.treatmentRuns.length === 2,
    'a real canvas click while armed must create two runs and leave the persistent tool armed');
  check(split.ann.points.length === 1
    && split.ann.seamPath.treatmentRuns[0].endNodeId === split.ann.points[0].nodeId
    && split.ann.seamPath.treatmentRuns[1].startNodeId === split.ann.points[0].nodeId,
  'the real pointer path must create one shared, gap-free boundary node');
  check(split.selection.part === `treatmentRun:${split.ann.seamPath.treatmentRuns[1].id}`,
    'the following run must be selected after the real pointer action');

  const twoNeedle = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('stitchesBtn').click();
    const button = document.getElementById('lineTreatment2NdlBtn');
    const reachable = { visible: button.offsetParent !== null, enabled: !button.disabled };
    button.click();
    const ann = d.getAnnotations().find(item => item.id === 12511);
    return { reachable, selection: d.getState().selection, ann };
  })()`);
  const firstRun = twoNeedle.ann.seamPath.treatmentRuns[0];
  const followingRun = twoNeedle.ann.seamPath.treatmentRuns[1];
  check(twoNeedle.reachable.visible && twoNeedle.reachable.enabled, 'Apply 2NDL must be reachable for the selected following run');
  check(firstRun.treatment.semantic.needleCount === 1 && followingRun.treatment.semantic.needleCount === 2,
    'the real 2NDL button must change only the selected run, not the full Seam Path');
  check(followingRun.treatment.semantic.needleGauge.status === 'tbc',
    'the UI-applied 2NDL Treatment must keep Needle Gauge explicitly TBC');

  const confirmedGauge = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const before = d.getAnnotations().find(item => item.id === 12511);
    const selectedRunId = before.seamPath.treatmentRuns[1].id;
    const geometry = before.seamPath.geometryFingerprint;
    if (document.getElementById('stitchesMenu').hidden) document.getElementById('stitchesBtn').click();
    document.getElementById('lineTreatmentCustomizeBtn').click();
    const count = document.querySelector('[data-treatment-needle-count]');
    const status = document.querySelector('[data-treatment-gauge-status]');
    const value = document.querySelector('[data-treatment-gauge-value]');
    const unit = document.querySelector('[data-treatment-gauge-unit]');
    const spacing = document.querySelector('[data-treatment-display-spacing]');
    const initial = { count: count.value, status: status.value, spacing: spacing.value };
    status.value = 'confirmed';
    status.dispatchEvent(new Event('change', { bubbles: true }));
    value.value = '6';
    unit.value = 'mm';
    const offsets = Array.from(document.querySelectorAll('[data-layer-field="offset"]'));
    offsets[0].value = '-20';
    offsets[1].value = '20';
    spacing.value = '40';
    document.querySelector('.treatment-dialog .picker-btn.primary').click();
    const after = d.getAnnotations().find(item => item.id === 12511);
    return { initial, geometry, selectedRunId, after };
  })()`);
  const confirmedRun = confirmedGauge.after.seamPath.treatmentRuns
    .find(run => run.id === confirmedGauge.selectedRunId);
  check(confirmedGauge.initial.count === '2' && confirmedGauge.initial.status === 'tbc'
      && confirmedGauge.initial.spacing === '8',
    `the editor must expose 2NDL semantic state separately from display spacing, got ${JSON.stringify(confirmedGauge.initial)}`);
  check(confirmedRun.treatment.semantic.needleGauge.status === 'confirmed'
      && confirmedRun.treatment.semantic.needleGauge.value === 6
      && confirmedRun.treatment.semantic.needleGauge.unit === 'mm',
    'a TD must be able to replace Gauge TBC with an explicit confirmed value/unit');
  check(confirmedRun.treatment.displaySpacing === 40
      && confirmedRun.treatment.layers.map(layer => layer.offset).join(',') === '-20,20',
    'display rail spacing and rendered offsets must remain editable presentation data, separate from Needle Gauge');
  check(confirmedGauge.after.seamPath.geometryFingerprint === confirmedGauge.geometry,
    'confirming Needle Gauge must not change Seam Path geometry');

  const bodySelection = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const clickWorld = (x, y) => {
      const view = d.getView();
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + x * view.zoom + view.panX;
      const clientY = rect.top + y * view.zoom + view.panY;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
      return d.getState().selection.part;
    };
    document.getElementById('toolSelect').click();
    const outerRailPart = clickWorld(600, 380);
    const leftPart = clickWorld(400, 360);
    const rightPart = clickWorld(600, 360);
    const beforeDelete = d.getAnnotations().find(item => item.id === 12511);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    const afterDelete = d.getAnnotations().find(item => item.id === 12511);
    for (let index = 0; index < 80 && !/cannot be deleted/i.test(document.getElementById('toast').textContent); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {
      outerRailPart, leftPart, rightPart,
      firstRunId: beforeDelete.seamPath.treatmentRuns[0].id,
      followingRunId: beforeDelete.seamPath.treatmentRuns[1].id,
      annotationKept: !!afterDelete,
      runCount: afterDelete?.seamPath?.treatmentRuns?.length,
      toast: document.getElementById('toast').textContent,
    };
  })()`);
  check(bodySelection.leftPart === `treatmentRun:${bodySelection.firstRunId}`
    && bodySelection.rightPart === `treatmentRun:${bodySelection.followingRunId}`,
  `clicking either visible interval must select its own Treatment Run, got ${JSON.stringify(bodySelection)}`);
  check(bodySelection.outerRailPart === `treatmentRun:${bodySelection.followingRunId}`,
    'clicking a wide visible 2NDL outer rail must hit its owning run, not only the invisible centerline');
  check(bodySelection.annotationKept && bodySelection.runCount === 2 && /cannot be deleted/i.test(bodySelection.toast),
    `generic Delete on a Treatment Run must preserve the whole seam and explain the explicit removal action, got ${JSON.stringify(bodySelection)}`);

  const removal = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const annBefore = d.getAnnotations().find(item => item.id === 12511);
    const nodeBefore = JSON.parse(JSON.stringify(annBefore.points[0]));
    const view = d.getView();
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + nodeBefore.point.x * view.zoom + view.panX;
    const clientY = rect.top + nodeBefore.point.y * view.zoom + view.panY;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
    const selectedPart = d.getState().selection.part;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    const afterGenericDelete = d.getAnnotations().find(item => item.id === 12511);
    for (let index = 0; index < 80 && !/owns a Treatment Break/i.test(document.getElementById('toast').textContent); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const genericDeleteToast = document.getElementById('toast').textContent;
    window.prompt = () => 'FOLLOWING';
    document.getElementById('stitchesBtn').click();
    const button = document.getElementById('lineTreatmentRemoveBreakBtn');
    const reachable = { visible: button.offsetParent !== null, enabled: !button.disabled };
    button.click();
    const afterRemove = d.getAnnotations().find(item => item.id === 12511);
    return { selectedPart, nodeBefore, afterGenericDelete, genericDeleteToast, reachable, afterRemove };
  })()`);
  check(removal.selectedPart === 'point0.point', 'clicking the boundary point must select its actual geometry anchor');
  check(removal.afterGenericDelete.points.length === 1 && /owns a Treatment Break/i.test(removal.genericDeleteToast),
    'generic Delete on the boundary anchor must be blocked without deleting geometry');
  check(removal.reachable.visible && removal.reachable.enabled,
    `Remove selected Treatment Break must become reachable only for the selected owning point, got ${JSON.stringify(removal.reachable)}`);
  check(removal.afterRemove.seamPath.treatmentRuns.length === 1
    && removal.afterRemove.points.length === 1
    && removal.afterRemove.points[0].nodeId === removal.nodeBefore.nodeId,
  'explicit Remove Treatment Break must merge ownership while retaining the exact geometry node');
  check(removal.afterRemove.seamPath.treatmentRuns[0].treatment.semantic.needleCount === 2,
    'the explicit FOLLOWING choice must retain 2NDL after the UI removal flow');

  const existingNode = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const treatment = { name: '1NDL existing node', semantic: { needleCount: 1 }, layers: [
      { id: 'existing-layer', pattern: 'solid', offset: 0, width: 1.6, color: 'black', spacing: 10, amplitude: 4 },
    ] };
    const ann = d.seamPath.addTestAnnotation({
      id: 12514, type: 'curved', start: { x: 260, y: 700 }, end: { x: 700, y: 700 },
      control1: { x: 330, y: 640 }, control2: { x: 630, y: 760 },
      points: [{
        point: { x: 480, y: 700 }, handleIn: { x: 410, y: 650 }, handleOut: { x: 550, y: 750 },
      }], lineTreatment: treatment,
    });
    const promoted = d.seamPath.promote(ann.id);
    const nodeId = promoted.points[0].nodeId;
    const canvas = document.getElementById('boardCanvas');
    if (document.getElementById('stitchesMenu').hidden) document.getElementById('stitchesBtn').click();
    document.getElementById('lineTreatmentBreakBtn').click();
    const view = d.getView();
    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + 480 * view.zoom + view.panX;
    const clientY = rect.top + 700 * view.zoom + view.panY;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
    const after = d.getAnnotations().find(item => item.id === ann.id);
    return { nodeId, after, state: d.getState(), toast: document.getElementById('toast').textContent };
  })()`);
  check(existingNode.after.points.length === 1 && existingNode.after.points[0].nodeId === existingNode.nodeId
      && existingNode.after.seamPath.treatmentRuns.length === 2,
    `clicking an existing interior node must reuse its stable identity and partition without adding geometry, got ${JSON.stringify(existingNode)}`);
  check(existingNode.state.selection.part === `treatmentRun:${existingNode.after.seamPath.treatmentRuns[1].id}`,
    'partitioning at an existing node must select the following run');

  const closed = await s.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const treatment = { name: '1NDL loop', semantic: { needleCount: 1 }, layers: [
      { id: 'loop-layer', pattern: 'solid', offset: 0, width: 1.6, color: 'black', spacing: 10, amplitude: 4 },
    ] };
    const loop = d.seamPath.addTestAnnotation({
      id: 12512, type: 'curved', start: { x: 980, y: 400 }, end: { x: 980, y: 400 },
      control1: { x: 1035.23, y: 400 }, control2: { x: 924.77, y: 400 },
      points: [
        { point: { x: 1080, y: 500 }, handleIn: { x: 1080, y: 444.77 }, handleOut: { x: 1080, y: 555.23 } },
        { point: { x: 980, y: 600 }, handleIn: { x: 1035.23, y: 600 }, handleOut: { x: 924.77, y: 600 } },
        { point: { x: 880, y: 500 }, handleIn: { x: 880, y: 555.23 }, handleOut: { x: 880, y: 444.77 } },
      ], lineTreatment: treatment,
    });
    const promoted = d.seamPath.promote(loop.id, { closed: true });
    const canvas = document.getElementById('boardCanvas');
    const clickWorld = (x, y) => {
      const view = d.getView();
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + x * view.zoom + view.panX;
      const clientY = rect.top + y * view.zoom + view.panY;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
    };
    const before = { history: d.seamPath.historyDepth(), seam: d.seamPath.get(loop.id) };
    document.getElementById('stitchesBtn').click();
    document.getElementById('lineTreatmentBreakBtn').click();
    clickWorld(1080, 500);
    const pending = {
      state: d.getState().treatmentBreakPending,
      history: d.seamPath.historyDepth(),
      seam: d.seamPath.get(loop.id),
    };
    clickWorld(1080, 500);
    const coincident = {
      state: d.getState().treatmentBreakPending,
      history: d.seamPath.historyDepth(),
      seam: d.seamPath.get(loop.id),
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const canceled = {
      state: d.getState().treatmentBreakPending,
      tool: d.getState().tool,
      history: d.seamPath.historyDepth(),
      seam: d.seamPath.get(loop.id),
    };
    document.getElementById('stitchesBtn').click();
    document.getElementById('lineTreatmentBreakBtn').click();
    clickWorld(1080, 500);
    clickWorld(880, 500);
    const committed = d.getAnnotations().find(item => item.id === loop.id);
    const selection = d.getState().selection;
    const history = d.seamPath.historyDepth();
    document.getElementById('stitchesBtn').click();
    document.getElementById('lineTreatment2NdlBtn').click();
    const treated = d.getAnnotations().find(item => item.id === loop.id);
    const project = d.exportProject();
    await d.loadProject(project);
    const restored = d.getAnnotations().find(item => item.id === loop.id);
    return { promoted, before, pending, coincident, canceled, committed, selection, history, treated, restored };
  })()`);
  check(closed.promoted.seamPath.closed === true && closed.promoted.seamPath.validationStatus === 'pass',
    'a coincident-endpoint cubic loop must normalize as an explicit closed Seam Path');
  check(closed.pending.state?.annotationId === 12512
      && closed.pending.history === closed.before.history
      && JSON.stringify(closed.pending.seam) === JSON.stringify(closed.before.seam),
    `the first closed-loop boundary must stay session-only and create no history or model mutation, got ${JSON.stringify({ beforeHistory: closed.before.history, pendingHistory: closed.pending.history, pendingState: closed.pending.state, beforeSeam: closed.before.seam, pendingSeam: closed.pending.seam })}`);
  check(closed.canceled.state === null && closed.canceled.tool === 'select'
      && closed.canceled.history === closed.before.history
      && JSON.stringify(closed.canceled.seam) === JSON.stringify(closed.before.seam),
    'Escape after the first loop boundary must be a true no-op');
  check(closed.coincident.state?.annotationId === 12512
      && closed.coincident.history === closed.before.history
      && JSON.stringify(closed.coincident.seam) === JSON.stringify(closed.before.seam),
    'a coincident second loop boundary must be rejected without model or history mutation');
  check(closed.committed.seamPath.treatmentRuns.length === 2
      && closed.committed.seamPath.treatmentRuns.filter(run => run.wrap).length === 1
      && closed.history === closed.before.history + 1,
    'the second loop boundary must commit exactly two complementary runs in one history step');
  const closedSelected = closed.committed.seamPath.treatmentRuns.find(run => `treatmentRun:${run.id}` === closed.selection.part);
  check(closedSelected?.startNodeId === closed.committed.points[0].nodeId
      && closedSelected?.endNodeId === closed.committed.points[2].nodeId
      && closedSelected.wrap === false,
    'the selected closed-loop run must be the explicit interval from the first click to the second');
  check(closed.treated.seamPath.treatmentRuns.find(run => run.id === closedSelected.id)?.treatment.semantic.needleCount === 2
      && closed.treated.seamPath.treatmentRuns.find(run => run.id !== closedSelected.id)?.treatment.semantic.needleCount === 1,
    '2NDL on a closed path must change only the run between the two TD-selected boundaries');
  check(JSON.stringify(closed.restored.seamPath.treatmentRuns) === JSON.stringify(closed.treated.seamPath.treatmentRuns),
    'closed-loop wrap ownership and treatments must survive Save/Open');

  const closedInterior = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    document.getElementById('modeManualBtn').click();
    if (!d.getState().sketchMode) document.getElementById('sketchFocusBtn').click();
    const treatment = { name: '1NDL loop interior', semantic: { needleCount: 1 }, layers: [
      { id: 'loop-interior-layer', pattern: 'solid', offset: 0, width: 1.6, color: 'black', spacing: 10, amplitude: 4 },
    ] };
    const loop = d.seamPath.addTestAnnotation({
      id: 12513, type: 'curved', start: { x: 980, y: 400 }, end: { x: 980, y: 400 },
      control1: { x: 1035.23, y: 400 }, control2: { x: 924.77, y: 400 },
      points: [
        { point: { x: 1080, y: 500 }, handleIn: { x: 1080, y: 444.77 }, handleOut: { x: 1080, y: 555.23 } },
        { point: { x: 980, y: 600 }, handleIn: { x: 1035.23, y: 600 }, handleOut: { x: 924.77, y: 600 } },
        { point: { x: 880, y: 500 }, handleIn: { x: 880, y: 555.23 }, handleOut: { x: 880, y: 444.77 } },
      ], lineTreatment: treatment,
    });
    d.seamPath.promote(loop.id, { closed: true });
    const before = {
      sample: d.seamPath.sample(loop.id),
      history: d.seamPath.historyDepth(),
      pointCount: d.getAnnotations().find(item => item.id === loop.id).points.length,
    };
    const cubic = t => {
      const mt = 1 - t;
      return {
        x: mt*mt*mt*980 + 3*mt*mt*t*1035.23 + 3*mt*t*t*1080 + t*t*t*1080,
        y: mt*mt*mt*400 + 3*mt*mt*t*400 + 3*mt*t*t*444.77 + t*t*t*500,
      };
    };
    const canvas = document.getElementById('boardCanvas');
    const clickWorld = point => {
      const view = d.getView();
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + point.x * view.zoom + view.panX;
      const clientY = rect.top + point.y * view.zoom + view.panY;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, button: 0, bubbles: true, cancelable: true }));
    };
    if (document.getElementById('stitchesMenu').hidden) document.getElementById('stitchesBtn').click();
    document.getElementById('lineTreatmentBreakBtn').click();
    clickWorld(cubic(0.25));
    clickWorld(cubic(0.75));
    const after = d.getAnnotations().find(item => item.id === loop.id);
    return { before, after, afterSample: d.seamPath.sample(loop.id), history: d.seamPath.historyDepth() };
  })()`);
  check(closedInterior.after.seamPath.treatmentRuns.length === 2
      && closedInterior.after.points.length === closedInterior.before.pointCount + 2
      && closedInterior.history === closedInterior.before.history + 1,
    'two interior clicks on one loop segment must insert two boundaries and commit once');
  const closedInteriorDistance = symmetricPolylineDistance(closedInterior.before.sample, closedInterior.afterSample);
  // The path is exact De Casteljau subdivision; this comparison is between
  // two independently chord-sampled render polylines whose per-segment sample
  // allocation changes when two nodes are inserted.
  check(closedInteriorDistance < 0.02,
    `same-segment closed-loop subdivision must preserve represented geometry; distance=${closedInteriorDistance}`);

  const preview = await s.eval(`(() => {
    document.querySelector('[data-page="preview"]').click();
    const canvas = document.querySelector('[data-pv-paper="pom"] canvas.pv-board');
    if (!canvas) return { active: window.__braAutoModeDebug.getState().activePage, canvas: false, painted: 0 };
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 0; index < data.length; index += 64) {
      if (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245) painted += 1;
    }
    return { active: window.__braAutoModeDebug.getState().activePage, canvas: true, painted };
  })()`);
  check(preview.active === 'preview' && preview.canvas && preview.painted > 50,
    `Preview & Export must render the same mixed-run board through the export painter, got ${JSON.stringify(preview)}`);

  const errors = await s.eval('window.__treatmentRunsErrors || []');
  check(errors.length === 0, 'browser console errors: ' + errors.join(' | '));
  await s.close();
  console.log(`PASS  treatment-runs-browser-check   ${passed}/${passed} assertions ok`);
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
    expression: `window.__treatmentRunsErrors=[];addEventListener('error',event=>window.__treatmentRunsErrors.push(String(event.message||event.error)))`,
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
