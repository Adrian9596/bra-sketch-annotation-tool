#!/usr/bin/env node
// Candidate V3 regression for the deterministic technical-flat lane.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadlessApp, analyzeSeamFixture, readFixtureDataUrl, screenshotTo } from './headless-app.mjs';
import {
  syntheticTechnicalFlatDataUrl,
  SYNTHETIC_EXPECTED_ZONES,
  SYNTHETIC_EXPECTED_APPEARANCES,
} from './auto-seam-synthetic-fixture.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureArg = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const screenshotArg = process.argv.find(arg => arg.startsWith('--screenshot='))?.slice('--screenshot='.length);
let app, passed = 0;
const check = (condition, message) => { if (!condition) throw new Error(message); passed += 1; };

async function fixtureDataUrl() {
  if (!fixtureArg) return syntheticTechnicalFlatDataUrl();
  return readFixtureDataUrl(path.resolve(fixtureArg));
}

async function main() {
  app = await launchHeadlessApp({ appDir, query: 'technical-flat', profilePrefix: 'auto-seam-flat-' });
  const { session } = app;
  const dataUrl = await fixtureDataUrl();
  const result = await analyzeSeamFixture(session, { dataUrl, resetBoard: false });
  check(result.contractVersion === 'auto-seam-candidate/3', 'Candidate V3 must be emitted');
  check(result.inputClass.value === 'technical_flat', `expected technical_flat, got ${JSON.stringify(result.inputClass)}`);
  check(result.analysisLane === 'technical_flat' && result.inputEligible, 'technical-flat lane must be eligible');
  check(result.automaticRois.length === 14, `technical-flat lane must emit 14 ROIs, got ${result.automaticRois.length}`);
  check(await session.eval(`window.__braAutoModeDebug.autoSeam.validateResult(${JSON.stringify(result)})`) === true,
    'Candidate V3 result must validate');
  check(result.candidates.length > 0, `clear technical-flat seams must produce candidates: ${JSON.stringify(result.abstentions)}`);
  check(result.diagnostics.sketchOutline?.emitsCandidate === false
      && result.diagnostics.sketchOutline?.source === 'source_pixels',
    'Sketch Outline must be diagnostic source-pixel evidence, never a seam candidate');
  // The synthetic draws zigzag on the neckline, both armholes and the hem
  // (straps carry a zigzag too but the strap corridor is template-seeded and
  // not asserted here). Every drawn zigzag must come back as a candidate. The
  // assertion is deferred to after the diagnostic JSON print below so a
  // failure still shows the per-zone evidence that explains it.
  let syntheticZoneFailure = null;
  if (!fixtureArg) {
    const found = new Set(result.candidates.map(candidate => `${candidate.semanticZone}/${candidate.side}`));
    const missing = SYNTHETIC_EXPECTED_ZONES.filter(zone => !found.has(zone));
    if (missing.length) syntheticZoneFailure = `synthetic zigzag zones must all be detected; missing ${missing.join(', ')} (got ${[...found].join(', ')})`;
    const byZone = new Map(result.candidates.map(candidate =>
      [`${candidate.semanticZone}/${candidate.side}`, candidate]));
    check(['left', 'right'].every(side => {
      const strap = byZone.get(`shoulder_strap/${side}`);
      return !strap || strap.appearanceType === 'zigzag';
    }), 'an unresolved strap zigzag must never be relabelled as a dashed pair');
    for (const [zoneSide, appearance] of Object.entries(SYNTHETIC_EXPECTED_APPEARANCES)) {
      check(byZone.get(zoneSide)?.appearanceType === appearance,
        `${zoneSide} must classify as ${appearance}, got ${JSON.stringify(byZone.get(zoneSide))}`);
    }
    check(result.candidates.filter(candidate => ['single_dashed', 'parallel_dashed'].includes(candidate.appearanceType))
      .every(candidate => candidate.classificationStatus === 'unresolved' && candidate.stitchType === null),
    'dashed appearance must not guess Single Needle, Double Needle, or Cover Stitch');
  }
  check(result.candidates.every(candidate => JSON.stringify(candidate.rawGeometry) === JSON.stringify(candidate.geometry)),
    'symmetry evidence must not rewrite independently observed geometry');
  check(result.candidates.every(candidate => candidate.roiTransform.roundTripMaxErrorPx <= 0.01),
    'every candidate must retain a reversible ROI/source transform');
  const contractExtensions = await session.eval(`(() => {
    const validate=window.__braAutoModeDebug.autoSeam.validateResult;
    const base=${JSON.stringify(result)};
    const multiple=JSON.parse(JSON.stringify(base));
    const extra=JSON.parse(JSON.stringify(multiple.candidates[0]));
    extra.id += '-independent-2'; extra.symmetryResult={status:'independent',counterpartCandidateId:null};
    multiple.candidates.push(extra);
    const unresolved=JSON.parse(JSON.stringify(base));
    const unknown=JSON.parse(JSON.stringify(unresolved.candidates[0]));
    unknown.id += '-unresolved'; unknown.semanticZone=null; unknown.zone=null; unknown.zoneStatus='unresolved';
    unknown.symmetryResult={status:'independent',counterpartCandidateId:null}; unresolved.candidates.push(unknown);
    let multipleAccepted=false, unresolvedAccepted=false;
    try { multipleAccepted=validate(multiple); } catch {}
    try { unresolvedAccepted=validate(unresolved); } catch {}
    return {multipleAccepted,unresolvedAccepted};
  })()`);
  check(contractExtensions.multipleAccepted && contractExtensions.unresolvedAccepted,
    `Candidate V3 must allow multiple independent observations and unresolved semantic zones: ${JSON.stringify(contractExtensions)}`);
  const applied = await session.eval(`(async () => {
    const d=window.__braAutoModeDebug;
    document.getElementById('modeManualBtn').click();
    document.getElementById('sketchFocusBtn').click();
    const run=await d.autoSeam.run();
    const drafts=d.getAnnotations().filter(annotation=>annotation.sourceMode==='auto-seam');
    return {runStatus:run.status,runCount:run.count,drafts:drafts.map(draft=>({
      semanticZone:draft.semanticZone,side:draft.side,reviewRequired:draft.reviewRequired,
      tdApproved:draft.tdApproved,contractVersion:draft.autoSeamContractVersion,
      appearanceType:draft.appearanceType,stitchType:draft.stitchType,
      stitchClassificationStatus:draft.stitchClassificationStatus,style:draft.style,
      start:draft.start,end:draft.end,control1:draft.control1,control2:draft.control2,points:draft.points,
    }))};
  })()`);
  check(applied.runStatus === 'applied' && applied.runCount === result.candidates.length
      && applied.drafts.length === result.candidates.length
      && applied.drafts.every(draft => draft.reviewRequired && !draft.tdApproved
        && draft.contractVersion === 'auto-seam-candidate/3'),
    `button action must apply every Candidate V3 path as an unapproved editable draft: ${JSON.stringify(applied)}`);
  if (!fixtureArg) {
    const expectedStyle = { solid_plain: 'solid', single_dashed: 'dashed', parallel_dashed: 'cover', zigzag: 'zigzag' };
    check(applied.drafts.every(draft => draft.style === expectedStyle[draft.appearanceType]),
      `every appearance must map to its existing renderer: ${JSON.stringify(applied.drafts)}`);
  }
  if (screenshotArg) await screenshotTo(session, path.resolve(screenshotArg));
  console.log(JSON.stringify({
    fixture: fixtureArg || 'synthetic',
    inputClass: result.inputClass,
    applied,
    candidates: result.candidates.map(candidate => ({
      id: candidate.id, zone: candidate.semanticZone, side: candidate.side,
      appearanceType: candidate.appearanceType, stitchType: candidate.stitchType,
      confidence: Number(candidate.confidence.overall.toFixed(3)),
      geometry: candidate.geometry,
    })),
    abstentions: result.abstentions.map(item => ({
      zone: item.zone, side: item.side, code: item.code,
      evidence: item.evidence ? {
        pathSupport: Number(item.evidence.pathSupport.toFixed(3)),
        continuity: Number(item.evidence.continuity.toFixed(3)),
        lateralActivity: Number(item.evidence.lateralActivity.toFixed(3)),
        lateralAlternation: Number(item.evidence.lateralAlternation.toFixed(3)),
        diagonalEnergy: Number(item.evidence.diagonalEnergy.toFixed(3)),
        diagonalAlternation: Number(item.evidence.diagonalAlternation.toFixed(3)),
        corridorDiagonalShare: Number(item.evidence.corridorDiagonalShare.toFixed(3)),
        corridorDiagonalBalance: Number(item.evidence.corridorDiagonalBalance.toFixed(3)),
        corridorTwoSidedCoverage: Number(item.evidence.corridorTwoSidedCoverage.toFixed(3)),
        ...(Number.isFinite(item.evidence.contourBindingFlipShare) ? {
          contourBindingInkShare: Number(item.evidence.contourBindingInkShare.toFixed(3)),
          contourBindingFlatShare: Number(item.evidence.contourBindingFlatShare.toFixed(3)),
          contourBindingFlipShare: Number(item.evidence.contourBindingFlipShare.toFixed(3)),
        } : {}),
      } : null,
    })),
  }, null, 2));
  check(!syntheticZoneFailure, syntheticZoneFailure || '');
  console.log(`PASS  auto-seam-technical-flat-check   ${passed} assertions ok`);
}

try { await main(); } catch (error) { process.exitCode = 1; console.error(`FAIL  auto-seam-technical-flat-check\n${error.stack || error}`); }
finally { await app?.close(); }
