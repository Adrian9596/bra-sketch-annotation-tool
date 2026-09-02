// US-109: Auto Detect Seam — APPLICATION LAYER. The only Auto Seam part that
// touches Board state, history or toasts: runs the pure analysis (see
// src/auto/seam/router.js), validates Candidate V2/V3, and applies
// every candidate as a review-required Auto Seam Draft. Oracle ROI fixtures
// are benchmark-only and are never imported here.
// Source part for app.js. Run `npm run build` after editing.

  async function autoSeamSourceSha256(sourceImage) {
    const dataURL = String(sourceImage?.dataURL || '');
    const comma = dataURL.indexOf(',');
    let bytes;
    if (comma >= 0 && /;base64/i.test(dataURL.slice(0, comma))) {
      const binary = atob(dataURL.slice(comma + 1));
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(dataURL);
    }
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function autoSeamAppearancePresentation(candidate) {
    const appearance = candidate.appearanceType || 'zigzag';
    if (appearance === 'solid_plain') {
      return { style: 'solid', label: 'Plain', lineTreatment: null };
    }
    if (appearance === 'single_dashed') {
      return { style: 'dashed', label: 'Single Dashed · stitch type unresolved', lineTreatment: null };
    }
    if (appearance === 'parallel_dashed') {
      return {
        style: 'cover',
        label: 'Parallel Dashed Pair · stitch type unresolved',
        lineTreatment: {
          name: 'Auto Seam · Parallel Dashed Pair',
          scale: 1,
          layers: [
            { pattern: 'dashed', offset: -4, width: 1.6, color: 'red', spacing: 10, amplitude: 4 },
            { pattern: 'dashed', offset: 4, width: 1.6, color: 'red', spacing: 10, amplitude: 4 },
          ],
        },
      };
    }
    return {
      style: 'zigzag',
      label: 'Zigzag',
      lineTreatment: {
        name: 'Auto Seam · Zigzag',
        scale: 1,
        layers: [{ pattern: 'zigzag', offset: 0, width: 1.6, color: 'red', spacing: 4, amplitude: 2.5 }],
      },
    };
  }

  function buildAutoSeamAnnotation(candidate, result, sourceImage, sourceSha256, runId) {
    const presentation = autoSeamAppearancePresentation(candidate);
    const geometry = candidate.geometry;
    const start = worldFromNormalized(geometry.start, sourceImage);
    const end = worldFromNormalized(geometry.end, sourceImage);
    const control1 = worldFromNormalized(geometry.control1, sourceImage);
    const control2 = worldFromNormalized(geometry.control2, sourceImage);
    const points = (geometry.points || []).map(point => ({
      point: worldFromNormalized(point.point, sourceImage),
      handleIn: worldFromNormalized(point.handleIn, sourceImage),
      handleOut: worldFromNormalized(point.handleOut, sourceImage),
    }));
    const roi = result.automaticRois.find(item => item.id === candidate.roiId);
    const ann = {
      id: createUniqueAnnotationId(),
      seq: null,
      type: 'curved',
      style: presentation.style,
      color: 'red',
      arrowType: 'none',
      lineWidth: DEFAULT_LINE_WIDTH,
      lineTreatment: presentation.lineTreatment,
      start, end, control1, control2, points,
      label: computeDefaultLabelPosition({ type: 'curved', start, end, control1, control2, points }),
      labelManual: false,
      text: null,
      desc: `Auto Detect Seam · ${presentation.label}`,
      value: null,
      auto: true,
      sourceMode: 'auto-seam',
      sourceImageId: sourceImage.id,
      sourceSha256,
      autoSeamRunId: runId,
      autoSeamContractVersion: result.contractVersion,
      pipelineVersion: result.pipelineVersion,
      inputClass: clone(result.inputClass),
      analysisLane: result.analysisLane,
      candidateId: candidate.id,
      semanticZone: candidate.semanticZone,
      semanticZoneStatus: candidate.zoneStatus,
      side: candidate.side,
      appearanceType: candidate.appearanceType || 'zigzag',
      stitchType: candidate.stitchType,
      stitchClassificationStatus: candidate.classificationStatus || 'resolved',
      geometrySource: candidate.geometrySource,
      evidenceStatus: candidate.evidenceStatus,
      symmetryResult: clone(candidate.symmetryResult),
      supportingPasses: candidate.supportingPasses.slice(),
      evidenceProvenance: clone(candidate.evidenceProvenance),
      evidenceConfidence: clone(candidate.confidence),
      rawGeometry: clone(candidate.rawGeometry),
      roiTransform: clone(candidate.roiTransform),
      automaticSemanticRoi: roi ? clone(roi) : null,
      reviewRequired: true,
      tdEdited: false,
      tdApproved: false,
      tdApprovalRequired: true,
      approvedAt: null,
    };
    ensureCurveControls(ann);
    return ann;
  }

  function isAutoSeamDraft(ann) {
    return !!(ann && ann.auto === true && ann.sourceMode === 'auto-seam'
      && ann.sourceImageId != null && ann.autoSeamRunId);
  }

  function isTDReviewDraft(ann) {
    return isAutoDraft(ann) || isAutoSeamDraft(ann);
  }

  async function runAutoDetectSeam() {
    if (state.appMode !== 'manual' || !state.sketchMode) {
      showToast('Auto Detect Seam is available only in Manual Mode · Sketch Focus.');
      return { status: 'wrong_context' };
    }
    if (state.autoSeam.running) return { status: 'busy' };
    const sourceImage = pickAutoSourceImage();
    if (!sourceImage || !sourceImage.img) {
      showToast('Add or paste a source image first.');
      return { status: 'no_source' };
    }
    const previous = state.annotations.filter(ann => isAutoSeamDraft(ann) && ann.sourceImageId === sourceImage.id);
    if (previous.length) {
      const confirmed = window.confirm(
        `Auto Detect Seam will replace all ${previous.length} previous Auto Seam Draft${previous.length === 1 ? '' : 's'} for this image, including TD edits.\n\nManual lines, POMs, and drafts from other images will be kept.`
      );
      if (!confirmed) return { status: 'cancelled' };
    }

    state.autoSeam.running = true;
    updateUI();
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const result = analyzeAutoSeamSource(sourceImage);
      validateAutoSeamResult(result);
      const sourceSha256 = await autoSeamSourceSha256(sourceImage);
      const runId = `auto-seam-${Date.now().toString(36)}-${sourceImage.id}`;
      const nextDrafts = result.candidates.map(candidate =>
        buildAutoSeamAnnotation(candidate, result, sourceImage, sourceSha256, runId));
      const previousIds = new Set(previous.map(ann => ann.id));
      state.annotations = state.annotations.filter(ann => !previousIds.has(ann.id)).concat(nextDrafts);
      if (state.selection.kind === 'annotation' && previousIds.has(state.selection.id)) {
        state.selection = { kind: null, id: null };
        state.selectedAnnotationIds = [];
      }
      state.autoSeam.lastRun = clone({
        sourceImageId: sourceImage.id,
        sourceSha256,
        runId,
        result,
        appliedAnnotationIds: nextDrafts.map(ann => ann.id),
      });
      if (previous.length || nextDrafts.length) pushHistoryIfChanged();
      requestRender();
      if (nextDrafts.length) {
        showToast(`Auto Detect Seam applied ${nextDrafts.length} seam draft${nextDrafts.length === 1 ? '' : 's'} · TD review required.`);
        return { status: 'applied', count: nextDrafts.length, result: clone(result) };
      }
      const reason = result.abstentions[0]?.reason || 'insufficient_evidence';
      showToast(`Không đủ bằng chứng — ${reason}.`);
      return { status: 'abstained', count: 0, result: clone(result) };
    } catch (error) {
      console.error('Auto Detect Seam failed:', error);
      showToast(`Không đủ bằng chứng — ${error.message || 'detector failed'}.`);
      return { status: 'error', error: String(error.message || error) };
    } finally {
      state.autoSeam.running = false;
      updateUI();
    }
  }
