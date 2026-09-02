#!/usr/bin/env node
// US-109 browser proof for the real Auto Detect Seam vertical slice.

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessApp } from './headless-app.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realFixture = path.join(appDir, 'demo/photos for seam detection/7.png');
const armholeFixture = path.join(appDir, 'demo/photos for seam detection/6.jpg');
const reviewDir = path.join(appDir, 'demo/photo-stitch-browser-review');
let app, passed = 0;
const check = (condition, message) => { if (!condition) throw new Error(message); passed += 1; };

async function main() {
  try { await access(realFixture); } catch {
    console.log('SKIP  photo-stitch-browser: private demo/photos for seam detection/7.png is absent');
    return;
  }
  try { await access(armholeFixture); } catch {
    console.log('SKIP  photo-stitch-browser: private demo/photos for seam detection/6.jpg is absent');
    return;
  }
  await mkdir(reviewDir, { recursive: true });
  app = await launchHeadlessApp({
    appDir, query: 'photo-stitch', windowSize: '1440,1000', profilePrefix: 'photo-stitch-browser-',
    readyExpression: 'window.__braAutoModeDebug && document.getElementById("autoDetectSeamBtn")',
  });
  const { session } = app;

  const setup = await session.eval(`(async () => {
    const response = await fetch('demo/photos%20for%20seam%20detection/7.png');
    const blob = await response.blob();
    const dataURL = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
    });
    await window.__braAutoModeDebug.addBoardImages([dataURL]);
    document.getElementById('modeManualBtn').click();
    const button = document.getElementById('autoDetectSeamBtn');
    const before = { hidden: button.offsetParent === null, command: window.__braAutoModeDebug.commands.list().find(c => c.id === 'board.auto-detect-seam') };
    document.getElementById('sketchFocusBtn').click();
    const after = { hidden: button.offsetParent === null, disabled: button.disabled, label: button.textContent.trim() };
    return { before, after, imageId: window.__braAutoModeDebug.getImages()[0].id };
  })()`);
  check(setup.before.hidden, 'Auto Detect Seam must be hidden in POM Focus');
  check(setup.before.command && setup.before.command.availability !== true,
    'Command Palette must explain that Auto Detect Seam requires Sketch Focus');
  check(!setup.after.hidden && !setup.after.disabled, 'Auto Detect Seam must be enabled in Manual + Sketch Focus with a source image');
  check(setup.after.label === 'Auto Detect Seam',
    `the visible action must use the lane-neutral permanent name, got ${setup.after.label}`);

  const analysis = await session.eval(`window.__braAutoModeDebug.autoSeam.analyzeImage(${JSON.stringify(setup.imageId)})`);
  check(analysis.contractVersion === 'photo-stitch-candidate/2'
      && analysis.inputClass.value === 'product_photo' && analysis.analysisLane === 'product_photo',
    `photo fixture must route deterministically through Candidate V2 product_photo: ${JSON.stringify(analysis.inputClass)}`);
  check(analysis.inputEligible === true, `the TD-confirmed front-view pilot must be P0 eligible: ${JSON.stringify(analysis.abstentions)}`);
  check(analysis.automaticRois.length === 6, `P0 must generate six Automatic ROIs, got ${analysis.automaticRois.length}`);
  check(await session.eval(`window.__braAutoModeDebug.autoSeam.validateResult(${JSON.stringify(analysis)})`) === true,
    'the runtime candidate/abstention result must pass its contract');
  check(analysis.candidates.length > 0, `the real zigzag-positive pilot must produce at least one candidate, got ${JSON.stringify(analysis.abstentions)}`);
  const underbustGeometry = analysis.candidates.filter(candidate => candidate.zone === 'underbust_band');
  const tdUnderbust = {
    left: { minX: 0.108, maxX: 0.488, minY: 0.685, maxY: 0.718 },
    right: { minX: 0.545, maxX: 0.902, minY: 0.685, maxY: 0.718 },
  };
  const centerAxis = analysis.view.centerAxis.xBottom;
  check(underbustGeometry.length === 2 && underbustGeometry.every(candidate => {
    const expected = tdUnderbust[candidate.side];
    const points = [candidate.geometry.start, candidate.geometry.control1,
      candidate.geometry.control2, candidate.geometry.end];
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    return expected
      && Math.abs(Math.min(...xs) - expected.minX) <= 0.025
      && Math.abs(Math.max(...xs) - expected.maxX) <= 0.025
      && Math.min(...ys) >= expected.minY
      && Math.max(...ys) <= expected.maxY;
  }), `underbust candidates must cover the TD-labelled lower Zigzag lane: ${JSON.stringify(underbustGeometry)}`);
  const leftUnderbust = underbustGeometry.find(candidate => candidate.side === 'left');
  const rightUnderbust = underbustGeometry.find(candidate => candidate.side === 'right');
  check(leftUnderbust.geometry.end.x <= centerAxis - 0.015
      && rightUnderbust.geometry.end.x >= centerAxis + 0.015
      && rightUnderbust.geometry.end.x - leftUnderbust.geometry.end.x >= 0.04,
    `underbust candidates must preserve the TD-labelled center-front closure gap: ${JSON.stringify({ centerAxis, left: leftUnderbust.geometry.end, right: rightUnderbust.geometry.end })}`);
  check(underbustGeometry.every(candidate => JSON.stringify(candidate.rawGeometry) === JSON.stringify(candidate.geometry)
      && candidate.geometrySource === 'raw_observation'
      && candidate.symmetryResult.status === 'corroborated'),
    `symmetry may corroborate but must not harmonize either observed underbust path: ${JSON.stringify(underbustGeometry)}`);
  const contractNegatives = await session.eval(`(() => {
    const validate = window.__braAutoModeDebug.autoSeam.validateResult;
    const base = ${JSON.stringify(analysis)};
    const rejects = mutate => { const copy=JSON.parse(JSON.stringify(base)); mutate(copy); try { validate(copy); return false; } catch { return true; } };
    return {
      duplicateRoi: rejects(copy => copy.automaticRois[1] = JSON.parse(JSON.stringify(copy.automaticRois[0]))),
      missingRoi: rejects(copy => copy.automaticRois.pop()),
      duplicateCandidate: rejects(copy => copy.candidates[1].id = copy.candidates[0].id),
      unknownZone: rejects(copy => copy.candidates[0].semanticZone = 'cup_seam'),
      badCoordinate: rejects(copy => copy.candidates[0].geometry.start.x = 1.2),
      missingRawGeometry: rejects(copy => delete copy.candidates[0].rawGeometry),
      invalidSymmetry: rejects(copy => copy.candidates[0].symmetryResult.status = 'fabricated'),
      ineligibleCandidate: rejects(copy => copy.inputEligible = false),
    };
  })()`);
  check(Object.values(contractNegatives).every(Boolean),
    `candidate contract negative controls must all reject: ${JSON.stringify(contractNegatives)}`);

  await session.eval(`document.getElementById('autoDetectSeamBtn').click()`);
  await session.waitFor('window.__braAutoModeDebug.autoSeam.getLastRun() && !document.getElementById("autoDetectSeamBtn").disabled', 8000);
  const applied = await session.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const run = d.autoSeam.getLastRun();
    const annotations = d.getAnnotations();
    const drafts = annotations.filter(a => a.sourceMode === 'auto-seam');
    return { run, drafts, measurementCount: annotations.filter(a => !['zigzag','cover','bartack'].includes(a.style)).length,
      project: d.exportProject() };
  })()`);
  check(applied.drafts.length === applied.run.result.candidates.length && applied.drafts.length > 0,
    'button click must directly create one Board draft per candidate');
  check(applied.drafts.every(draft => draft.style === 'zigzag' && draft.reviewRequired === true
      && draft.tdApproved === false && draft.sourceMode === 'auto-seam' && draft.sourceImageId === setup.imageId),
    'every direct-applied line must remain editable, review-required, unapproved, and image-owned');
  check(applied.drafts.every(draft => draft.automaticSemanticRoi && draft.sourceSha256?.length === 64
      && draft.evidenceConfidence && draft.evidenceProvenance.length >= 2 && draft.rawGeometry
      && draft.autoSeamContractVersion === 'photo-stitch-candidate/2'),
    'every Auto Seam Draft must persist Candidate V2 raw geometry, ROI, source hash, and pass provenance');
  check(applied.measurementCount === 0, 'unlabelled Zigzag Auto Seam Drafts must not enter the POM measurement set');
  check(applied.project.state.annotations.every(annotation => annotation.sourceMode === 'auto-seam'),
    'project serialization must preserve Auto Seam Draft metadata');
  const appliedScreenshot = await session.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path.join(reviewDir, 'applied.png'), Buffer.from(appliedScreenshot.data, 'base64'));
  const pointerEdit = await session.eval(`(async () => {
    const d=window.__braAutoModeDebug; const draft=d.getAnnotations().find(a=>a.sourceMode==='auto-seam');
    const before={ x:draft.start.x, y:draft.start.y }; const viewport=d.getViewport(); const rect=document.getElementById('boardCanvas').getBoundingClientRect();
    const x=rect.left+before.x*viewport.zoom+viewport.panX; const y=rect.top+before.y*viewport.zoom+viewport.panY;
    const fire=(type,cx,cy,buttons)=>document.getElementById('boardCanvas').dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:cx,clientY:cy,button:0,buttons}));
    fire('mousedown',x,y,1); fire('mousemove',x+24,y+6,1); fire('mouseup',x+24,y+6,0);
    await new Promise(resolve=>setTimeout(resolve,120));
    const after=d.getAnnotations().find(a=>a.id===draft.id);
    return { id:draft.id, before, after };
  })()`);
  check(pointerEdit.after.tdEdited === true && pointerEdit.after.tdApproved === false
      && Math.hypot(pointerEdit.after.start.x-pointerEdit.before.x, pointerEdit.after.start.y-pointerEdit.before.y) > 1,
    'a real endpoint drag must edit Auto Seam geometry and preserve review-required provenance');

  const replacement = await session.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const old = d.getAnnotations().filter(a => a.sourceMode === 'auto-seam');
    const manual = { id: 990001, seq: 1, type:'straight', style:'solid', color:'red', arrowType:'double', lineWidth:2.5,
      start:{x:10,y:10}, end:{x:110,y:10}, control1:null, control2:null, points:[], label:{x:60,y:-8}, labelManual:false, text:null, value:null };
    const other = JSON.parse(JSON.stringify(old[0])); other.id = 990002; other.sourceImageId = 999999; other.autoSeamRunId = 'other-image-run';
    d.styleEvidence.pushAnnotation(manual); d.styleEvidence.pushAnnotation(other);
    const edited = d.autoSeam.markTdEdit(old[0].id);
    const baselineDepth = d.autoSeam.commitHistory();
    const baseline = JSON.stringify(d.getAnnotations());
    window.confirm = () => false;
    const cancelled = await d.autoSeam.run();
    const afterCancel = JSON.stringify(d.getAnnotations());
    const cancelDepth = d.autoSeam.historyDepth();
    window.confirm = () => true;
    const rerun = await d.autoSeam.run();
    const after = d.getAnnotations();
    const rerunDepth = d.autoSeam.historyDepth();
    const oldIds = old.map(a => a.id);
    const facts = {
      edited, baseline, cancelled, afterCancel, cancelDepth, baselineDepth, rerun, rerunDepth,
      oldGone: oldIds.every(id => !after.some(a => a.id === id)),
      manualKept: after.some(a => a.id === manual.id),
      otherKept: after.some(a => a.id === other.id),
    };
    facts.undo = await d.autoSeam.undo();
    return facts;
  })()`);
  check(replacement.edited?.tdEdited === true && replacement.edited?.tdApproved === false,
    'TD correction must mark Auto Seam provenance as edited and still unapproved');
  check(replacement.cancelled.status === 'cancelled' && replacement.afterCancel === replacement.baseline
      && replacement.cancelDepth === replacement.baselineDepth,
    'canceling the re-run confirmation must preserve geometry and history exactly');
  check(replacement.rerun.status === 'applied' && replacement.oldGone,
    'confirmed re-run must replace every old same-image Auto Seam Draft including TD edits');
  check(replacement.manualKept && replacement.otherKept,
    'confirmed re-run must preserve manual lines and Auto Seam Drafts owned by another image');
  check(replacement.rerunDepth === replacement.baselineDepth + 1,
    'confirmed replacement must create exactly one undo history transaction');
  check(replacement.undo.some(a => a.id === replacement.edited.id && a.tdEdited === true)
      && replacement.undo.some(a => a.id === 990001) && replacement.undo.some(a => a.id === 990002),
    'one Undo must restore the replaced TD-edited set and preserve isolated content');

  const persistence = await session.eval(`(async () => {
    const d = window.__braAutoModeDebug; const project = d.exportProject();
    await d.loadProject(project);
    const drafts = d.getAnnotations().filter(a => a.sourceMode === 'auto-seam');
    return { drafts, sketchMode: d.getState().sketchMode };
  })()`);
  check(persistence.drafts.length > 0 && persistence.drafts.every(draft => draft.reviewRequired === true
      && draft.automaticSemanticRoi && draft.sourceSha256?.length === 64),
    'save/reopen must preserve Auto Seam Draft geometry and evidence provenance');
  check(persistence.sketchMode === false, 'project reopen must still return to POM Focus');

  const armhole = await session.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const empty = d.exportProject(); empty.state.annotations=[]; empty.state.images=[]; empty.state.idCounter=1; empty.state.nextSequence=1;
    await d.loadProject(empty);
    const response = await fetch('demo/photos%20for%20seam%20detection/6.jpg');
    const blob = await response.blob();
    const dataURL = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
    });
    await d.addBoardImages([dataURL]);
    document.getElementById('modeManualBtn').click(); document.getElementById('sketchFocusBtn').click();
    const imageId = d.getImages()[0].id;
    const analysis = await d.autoSeam.analyzeImage(imageId);
    const run = await d.autoSeam.run();
    return { analysis, run, annotations: d.getAnnotations().filter(a => a.sourceMode === 'auto-seam') };
  })()`);
  const armholeCandidates = armhole.analysis.candidates.filter(candidate => candidate.zone === 'armhole');
  check(armhole.analysis.inputEligible === true && armholeCandidates.length === 2,
    `the TD-confirmed armhole photo must produce exactly one bilateral armhole pair: ${JSON.stringify(armhole.analysis)}`);
  const tdArmhole = {
    left: { minX: 0.055, maxX: 0.17, minY: 0.29, maxY: 0.56 },
    right: { minX: 0.83, maxX: 0.945, minY: 0.29, maxY: 0.56 },
  };
  check(armholeCandidates.every(candidate => {
    const expected = tdArmhole[candidate.side];
    const points = [candidate.geometry.start, candidate.geometry.control1, candidate.geometry.control2, candidate.geometry.end];
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    return expected
      && Math.abs(Math.min(...xs) - expected.minX) <= 0.02
      && Math.abs(Math.max(...xs) - expected.maxX) <= 0.02
      && Math.abs(Math.min(...ys) - expected.minY) <= 0.02
      && Math.abs(Math.max(...ys) - expected.maxY) <= 0.02;
  }), `armhole candidates must cover the TD-labelled outer binding paths: ${JSON.stringify(armholeCandidates)}`);
  const armholeLeft = armholeCandidates.find(candidate => candidate.side === 'left');
  const armholeRight = armholeCandidates.find(candidate => candidate.side === 'right');
  check(armholeLeft.geometry.end.x <= armholeLeft.geometry.start.x - 0.08
      && armholeRight.geometry.end.x >= armholeRight.geometry.start.x + 0.08,
    `armhole candidates must travel outward from strap to garment edge, never inward into the cup: ${JSON.stringify({ left: armholeLeft.geometry, right: armholeRight.geometry })}`);
  const necklineCandidates = armhole.analysis.candidates.filter(candidate => candidate.zone === 'neckline');
  const tdNeckline = {
    left: [{ x: 0.19, y: 0.29 }, { x: 0.225, y: 0.35 }, { x: 0.31, y: 0.42 }, { x: 0.39, y: 0.49 }, { x: 0.46, y: 0.56 }, { x: 0.49, y: 0.60 }],
    right: [{ x: 0.81, y: 0.29 }, { x: 0.775, y: 0.35 }, { x: 0.69, y: 0.42 }, { x: 0.61, y: 0.49 }, { x: 0.54, y: 0.56 }, { x: 0.51, y: 0.60 }],
  };
  check(necklineCandidates.length === 2 && necklineCandidates.every(candidate => {
    const reference = tdNeckline[candidate.side];
    if (!reference) return false;
    const geometry = candidate.geometry;
    const samples = Array.from({ length: 201 }, (_, index) => {
      const t = index / 200, mt = 1 - t;
      return {
        x: mt ** 3 * geometry.start.x + 3 * mt * mt * t * geometry.control1.x
          + 3 * mt * t * t * geometry.control2.x + t ** 3 * geometry.end.x,
        y: mt ** 3 * geometry.start.y + 3 * mt * mt * t * geometry.control1.y
          + 3 * mt * t * t * geometry.control2.y + t ** 3 * geometry.end.y,
      };
    });
    return reference.every(point => Math.min(...samples.map(sample => Math.hypot(sample.x - point.x, sample.y - point.y))) <= 0.045);
  }), `neckline candidates must follow the full TD-corrected curved lace-to-cup binding, not merely share its endpoints: ${JSON.stringify(necklineCandidates)}`);
  const necklineLeft = necklineCandidates.find(candidate => candidate.side === 'left');
  const necklineRight = necklineCandidates.find(candidate => candidate.side === 'right');
  check(Math.abs(necklineLeft.geometry.control1.x - necklineLeft.geometry.start.x) <= 0.002
      && Math.abs(necklineRight.geometry.control1.x - necklineRight.geometry.start.x) <= 0.002
      && necklineLeft.geometry.control2.x >= necklineLeft.geometry.start.x
      && necklineRight.geometry.control2.x <= necklineRight.geometry.start.x,
    `neckline candidates must leave the strap nearly vertically and bend only inward, never hook outward onto cup edge: ${JSON.stringify({ left: necklineLeft.geometry, right: necklineRight.geometry })}`);
  check(necklineLeft.geometry.end.x >= necklineLeft.geometry.start.x + 0.25
      && necklineRight.geometry.end.x <= necklineRight.geometry.start.x - 0.25,
    `neckline candidates must travel inward from strap to center front: ${JSON.stringify({ left: necklineLeft.geometry, right: necklineRight.geometry })}`);
  check(necklineLeft.geometry.end.x < necklineRight.geometry.end.x
      && necklineRight.geometry.end.x - necklineLeft.geometry.end.x >= 0.015,
    `neckline candidates must preserve the center-front flower/closure gap instead of crossing into one false V: ${JSON.stringify({ left: necklineLeft.geometry.end, right: necklineRight.geometry.end })}`);
  check(armhole.run.status === 'applied' && armhole.annotations.length === 4
      && ['armhole', 'neckline'].every(zone => armhole.annotations.filter(annotation => annotation.semanticZone === zone).length === 2)
      && new Set(armhole.annotations.map(annotation => annotation.side)).size === 2,
    `the corrected armhole and neckline pairs must apply as four editable zone-and-side-owned drafts: ${JSON.stringify(armhole)}`);
  const armholeScreenshot = await session.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path.join(reviewDir, 'armhole-applied.png'), Buffer.from(armholeScreenshot.data, 'base64'));

  const blank = await session.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    const empty = d.exportProject(); empty.state.annotations=[]; empty.state.images=[]; empty.state.idCounter=1; empty.state.nextSequence=1;
    await d.loadProject(empty);
    const canvas=document.createElement('canvas'); canvas.width=600; canvas.height=800;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,600,800);
    await d.addBoardImages([canvas.toDataURL('image/png')]);
    document.getElementById('modeManualBtn').click(); document.getElementById('sketchFocusBtn').click();
    const result=await d.autoSeam.run();
    return { result, annotations:d.getAnnotations() };
  })()`);
  check(blank.result.status === 'abstained' && blank.annotations.length === 0,
    'an ineligible blank image must explicitly abstain and create no Board line');

  const external = await session.eval(`performance.getEntriesByType('resource').map(r=>r.name).filter(name => !name.startsWith(location.origin) && !name.startsWith('data:') && !name.startsWith('blob:'))`);
  check(external.length === 0, `Auto Detect Seam must remain offline, external resources: ${external.join(', ')}`);
  const abstentionScreenshot = await session.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path.join(reviewDir, 'abstention.png'), Buffer.from(abstentionScreenshot.data, 'base64'));
  console.log(`PASS  photo-stitch-browser   ${passed}/${passed} assertions ok`);
}

try { await main(); } catch (error) { process.exitCode = 1; console.error(`FAIL  photo-stitch-browser\n${error.stack || error}`); }
finally { await app?.close(); }
