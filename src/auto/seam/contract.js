// Auto Detect Seam Candidate V2/V3 shared contract. V2 remains authoritative
// for product photos; V3 separates visible appearance from stitch meaning for
// technical flats.
// Source part for app.js. Run npm run build after editing.

  function autoSeamPhotoOutputZones() {
    return ['underbust_band', 'neckline', 'armhole'];
  }

  function autoSeamTechnicalFlatOutputZones() {
    return ['shoulder_strap', 'neckline', 'armhole', 'cup_edge', 'cup_seam', 'underbust_band', 'side_seam'];
  }

  function autoSeamOutputZones(lane = 'product_photo') {
    return lane === 'technical_flat' ? autoSeamTechnicalFlatOutputZones() : autoSeamPhotoOutputZones();
  }

  function autoSeamClamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function autoSeamUnitPoint(point) {
    return !!point && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
      && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1;
  }

  function autoSeamGeometryIsValid(geometry) {
    return !!geometry
      && [geometry.start, geometry.control1, geometry.control2, geometry.end].every(autoSeamUnitPoint)
      && Array.isArray(geometry.points) && geometry.points.length <= 8
      && geometry.points.every(point => point
        && [point.point, point.handleIn, point.handleOut].every(autoSeamUnitPoint));
  }

  function autoSeamRoiTransform(model, polygon) {
    const xs = polygon.map(point => point.x);
    const ys = polygon.map(point => point.y);
    const padding = 0.006;
    const left = autoSeamClamp01(Math.min(...xs) - padding);
    const right = autoSeamClamp01(Math.max(...xs) + padding);
    const top = autoSeamClamp01(Math.min(...ys) - padding);
    const bottom = autoSeamClamp01(Math.max(...ys) + padding);
    const sourceRect = {
      x: left * model.naturalWidth,
      y: top * model.naturalHeight,
      width: Math.max(1, (right - left) * model.naturalWidth),
      height: Math.max(1, (bottom - top) * model.naturalHeight),
    };
    const scaleX = model.width / model.naturalWidth;
    const scaleY = model.height / model.naturalHeight;
    return {
      sourceSize: { width: model.naturalWidth, height: model.naturalHeight },
      analysisSize: { width: model.width, height: model.height },
      sourceRect,
      analysisRect: {
        x: sourceRect.x * scaleX,
        y: sourceRect.y * scaleY,
        width: sourceRect.width * scaleX,
        height: sourceRect.height * scaleY,
      },
      sourceToAnalysis: { scaleX, scaleY, offsetX: 0, offsetY: 0 },
      analysisToSource: { scaleX: 1 / scaleX, scaleY: 1 / scaleY, offsetX: 0, offsetY: 0 },
      roundTripMaxErrorPx: 0,
    };
  }

  function autoSeamTransformIsValid(transform) {
    if (!transform || !transform.sourceSize || !transform.analysisSize
        || !transform.sourceRect || !transform.analysisRect
        || !transform.sourceToAnalysis || !transform.analysisToSource) return false;
    const finitePositive = value => Number.isFinite(value) && value > 0;
    if (![transform.sourceSize.width, transform.sourceSize.height,
      transform.analysisSize.width, transform.analysisSize.height,
      transform.sourceRect.width, transform.sourceRect.height,
      transform.analysisRect.width, transform.analysisRect.height].every(finitePositive)) return false;
    if (!Number.isFinite(transform.roundTripMaxErrorPx) || transform.roundTripMaxErrorPx > 0.01) return false;
    const x = transform.sourceRect.x + transform.sourceRect.width * 0.37;
    const y = transform.sourceRect.y + transform.sourceRect.height * 0.61;
    const ax = x * transform.sourceToAnalysis.scaleX + transform.sourceToAnalysis.offsetX;
    const ay = y * transform.sourceToAnalysis.scaleY + transform.sourceToAnalysis.offsetY;
    const sx = ax * transform.analysisToSource.scaleX + transform.analysisToSource.offsetX;
    const sy = ay * transform.analysisToSource.scaleY + transform.analysisToSource.offsetY;
    return Math.hypot(sx - x, sy - y) <= 0.01;
  }

  function validateAutoSeamResult(result) {
    const candidateV2 = result?.contractVersion === 'photo-stitch-candidate/2';
    const candidateV3 = result?.contractVersion === 'auto-seam-candidate/3';
    if (!candidateV2 && !candidateV3) throw new Error('invalid Auto Seam contract version');
    if (candidateV3 && result.analysisLane !== 'technical_flat') {
      throw new Error('Candidate V3 is limited to the technical-flat lane');
    }
    if (!['product_photo', 'technical_flat', 'unknown'].includes(result.inputClass?.value)
        || !result.inputClass.ruleId || !result.inputClass.features) {
      throw new Error('invalid deterministic Auto Seam input classification');
    }
    if (result.analysisLane !== result.inputClass.value) throw new Error('input class and analysis lane disagree');
    if (!Array.isArray(result.automaticRois) || !Array.isArray(result.candidates) || !Array.isArray(result.abstentions)) {
      throw new Error('Auto Seam result arrays are missing');
    }
    const laneZones = new Set(autoSeamOutputZones(result.analysisLane));
    const roiIds = new Set();
    result.automaticRois.forEach(roi => {
      if (!roi.id || roiIds.has(roi.id)) throw new Error('duplicate or missing Automatic ROI id');
      roiIds.add(roi.id);
      if (!laneZones.has(roi.zone) || !['left', 'right', 'bilateral'].includes(roi.side)) {
        throw new Error('unsupported Automatic ROI identity');
      }
      if (!Array.isArray(roi.polygon) || roi.polygon.length < 4 || roi.polygon.length > 12
          || !roi.polygon.every(autoSeamUnitPoint) || !autoSeamTransformIsValid(roi.transform)) {
        throw new Error(`invalid Automatic ROI ${roi.id}`);
      }
    });
    if (result.inputEligible && result.analysisLane !== 'unknown'
        && result.automaticRois.length !== autoSeamOutputZones(result.analysisLane).length * 2) {
      throw new Error('eligible input must contain the complete lane-specific Automatic ROI set');
    }
    const candidateIds = new Set();
    result.candidates.forEach(candidate => {
      if (!candidate.id || candidateIds.has(candidate.id)) throw new Error('duplicate or missing candidate id');
      candidateIds.add(candidate.id);
      if (!['left', 'right', 'bilateral'].includes(candidate.side)) {
        throw new Error('candidate has an unsupported side');
      }
      if (candidateV2 && candidate.stitchType !== 'zigzag') {
        throw new Error('Candidate V2 exceeds Zigzag output authority');
      }
      if (candidateV3) {
        const appearances = ['solid_plain', 'single_dashed', 'parallel_dashed', 'zigzag'];
        const stitchTypes = ['plain', 'single_needle', 'double_needle', 'cover_stitch', 'zigzag', null];
        if (!appearances.includes(candidate.appearanceType)
            || !stitchTypes.includes(candidate.stitchType)
            || !['resolved', 'unresolved'].includes(candidate.classificationStatus)) {
          throw new Error('Candidate V3 has an invalid appearance/classification state');
        }
        if ((candidate.classificationStatus === 'unresolved') !== (candidate.stitchType === null)) {
          throw new Error('Candidate V3 unresolved classification must keep stitchType null');
        }
        if ((candidate.appearanceType === 'zigzag' && candidate.stitchType !== 'zigzag')
            || (candidate.appearanceType === 'solid_plain' && candidate.stitchType !== 'plain')
            || (['single_dashed', 'parallel_dashed'].includes(candidate.appearanceType)
              && candidate.classificationStatus !== 'unresolved')) {
          throw new Error('Candidate V3 appearance exceeds stitch classification authority');
        }
      }
      const resolved = candidate.zoneStatus === 'resolved';
      if ((resolved && !laneZones.has(candidate.semanticZone))
          || (!resolved && !(candidate.zoneStatus === 'unresolved' && candidate.semanticZone === null))) {
        throw new Error('invalid candidate semantic-zone state');
      }
      if (!candidate.reviewRequired || candidate.evidenceStatus !== 'observed') {
        throw new Error('candidate is missing review/evidence state');
      }
      if (!autoSeamGeometryIsValid(candidate.rawGeometry) || !autoSeamGeometryIsValid(candidate.geometry)) {
        throw new Error(`invalid candidate geometry ${candidate.id}`);
      }
      if (!candidate.roiId || !roiIds.has(candidate.roiId) || !autoSeamTransformIsValid(candidate.roiTransform)) {
        throw new Error(`candidate ${candidate.id} is missing ROI provenance`);
      }
      if (!Array.isArray(candidate.evidenceProvenance) || candidate.evidenceProvenance.length < 2
          || candidate.evidenceProvenance.some(pass => !pass.passId || pass.source !== 'source_pixels'
            || !['pass', 'support'].includes(pass.status))) {
        throw new Error('candidate is missing explicit source-pixel pass provenance');
      }
      if (!candidate.confidence || Object.values(candidate.confidence).some(value =>
        !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new Error('candidate is missing bounded evidence confidence');
      }
      if (!candidate.symmetryResult || !['corroborated', 'independent', 'unavailable', 'copied'].includes(candidate.symmetryResult.status)) {
        throw new Error('candidate has an invalid symmetry evidence state');
      }
      if (candidate.symmetryResult.status === 'corroborated'
          && !result.candidates.some(item => item.id === candidate.symmetryResult.counterpartCandidateId
            && item.id !== candidate.id)) {
        throw new Error('candidate symmetry counterpart is unavailable');
      }
    });
    result.abstentions.forEach(abstention => {
      if (!abstention || !['image', 'zone'].includes(abstention.scope) || !abstention.code || !abstention.reason) {
        throw new Error('invalid abstention record');
      }
      if (abstention.scope === 'zone'
          && (!laneZones.has(abstention.zone) || !['left', 'right', 'bilateral'].includes(abstention.side))) {
        throw new Error('invalid zone abstention identity');
      }
    });
    if (!result.inputEligible && result.candidates.length) throw new Error('ineligible input cannot produce a candidate');
    return true;
  }
