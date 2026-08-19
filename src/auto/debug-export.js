// Debug / introspection export builders for offline tooling. Source part
// for app.js. Run `npm run build` after editing.
//
// exportGroundTruth/downloadGroundTruth emit a normalized anchor JSON for
// scripts/accuracy-tests.mjs. buildCvDebugExport/downloadCvDebugExport
// dump the intermediate CV pipeline state captured by runOfflineDetection
// when window.__braAutoModeDebug.cv.setEnabled(true) is on (or ?cvDebug=1).
// buildStageDebugSummary is the per-pipeline-stage read-only projection
// used by the Engineering Workflow debug view.
//
// The window.__braAutoModeDebug facade that wires these onto the by-name
// test-suite contract lives in the sibling src/auto/debug-api.js, which
// loads after this file.

  // -------- Ground-truth labeling export (accuracy harness) --------
  //
  // Serializes the current TD-corrected anchors as ground truth for
  // scripts/accuracy-tests.mjs. Anchors are normalized [0,1] in the source
  // image's native pixel space, so they are directly comparable to a fresh
  // detector run on the same image regardless of board zoom / scale / pan.
  // This is the only thing that turns "the detector is stable" (golden tests)
  // into "the detector is correct" — the seeded anchors are scored against
  // these human-placed positions.
  function exportGroundTruth(imageName) {
    const anchors = {};
    for (const a of state.autoMode.anchors) {
      anchors[a.kind] = {
        x: Math.round(a.x * 1e6) / 1e6,
        y: Math.round(a.y * 1e6) / 1e6,
        viewRole: a.viewRole || null,
      };
    }
    const det = state.autoMode.detection || null;
    const viewCount = det && Array.isArray(det.viewBoxes) ? det.viewBoxes.length
      : (det && Array.isArray(det.views) ? det.views.length : null);
    return {
      image: imageName || null,
      labeledAt: new Date().toISOString(),
      ruleVersion: AUTO_RULE_VERSION,
      anchorCount: Object.keys(anchors).length,
      viewCount,
      anchors,
    };
  }

  // Trigger an in-browser download of the current ground truth. Used by the
  // ?label=1 labeling button (see maybeShowGroundTruthLabeler in src/dev/url-bootstrap.js).
  function downloadGroundTruth(imageName) {
    if (!state.autoMode.anchors.length) {
      showToast('No anchors to save. Run Detect Sketch and correct the anchors first.', 4200);
      return null;
    }
    const gt = exportGroundTruth(imageName);
    const safe = String(imageName || 'ground-truth').replace(/[^\w.\-]+/g, '_');
    const fileName = /\.json$/i.test(safe) ? safe : safe + '.json';
    try {
      const blob = new Blob([JSON.stringify(gt, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Saved ground truth: ' + fileName + ' (' + gt.anchorCount + ' anchors).');
    } catch (err) {
      console.warn('[Ground Truth] download failed:', err);
      showToast('Could not save ground truth file.', 4200);
    }
    return gt;
  }

  // -------- CV Debug export (compact) --------
  //
  // Bundles the most useful detection signals in a single JSON blob a TD can
  // save and diff later. Designed to answer "why did this image fail?" without
  // the TD having to re-open the page and reproduce by hand. Includes:
  //   - image identity (name/id, displayed + sample size)
  //   - detection params (effective, after learning bias)
  //   - threshold values + per-stage timing
  //   - detected anchors with normalized position + confidence tier
  //   - learned parameter sample counts + current resolved params
  //   - validation status (errors + warnings)
  //   - the full CV debug snapshot (rows/cols/components/etc.) when CV Debug
  //     mode was on for the last detection — null otherwise
  function buildCvDebugExport(imageName) {
    const det = state.autoMode.detection || null;
    const image = det
      ? (state.images.find(im => im.id === det.sourceImageId) || pickAutoSourceImage())
      : pickAutoSourceImage();
    const anchors = (state.autoMode.anchors || []).map(a => ({
      kind: a.kind,
      name: a.name,
      group: a.group,
      x: Math.round(a.x * 1e6) / 1e6,
      y: Math.round(a.y * 1e6) / 1e6,
      viewRole: a.viewRole || null,
      confidence: a.confidence || null,
      autoFilled: !!a.autoFilled,
      calibrated: !!a.calibrated,
      source: a.source || null,
      reviewRequired: !!a.reviewRequired,
      cupModelId: a.cupModelId || null,
    }));
    const learnedParams = (typeof getLearnedDetectionParams === 'function')
      ? getLearnedDetectionParams()
      : null;
    const learning = {
      enabled: typeof isLearningEnabled === 'function' ? isLearningEnabled() : null,
      sampleCount: typeof getLearningSampleCount === 'function' ? getLearningSampleCount() : 0,
      learnedParams,
      paramSampleCounts: learnedParams && learnedParams.sampleCounts
        ? { ...learnedParams.sampleCounts }
        : null,
    };
    const validation = state.autoMode.validation
      ? {
        status: state.autoMode.validation.status || null,
        errors: Array.isArray(state.autoMode.validation.errors)
          ? state.autoMode.validation.errors.slice()
          : [],
        warnings: Array.isArray(state.autoMode.validation.warnings)
          ? state.autoMode.validation.warnings.slice()
          : [],
      }
      : null;
    const cvDebug = state.autoMode.cvDebug && state.autoMode.cvDebug.lastDebug
      ? clone(state.autoMode.cvDebug.lastDebug)
      : null;
    return {
      exportedAt: new Date().toISOString(),
      ruleVersion: AUTO_RULE_VERSION,
      templateVersion: AUTO_TEMPLATE_VERSION,
      image: image ? {
        name: imageName || image.id || null,
        id: image.id || null,
        displayedWidth: image.width || null,
        displayedHeight: image.height || null,
        sampleWidth: det ? det.sampleWidth : null,
        sampleHeight: det ? det.sampleHeight : null,
      } : { name: imageName || null, id: null },
      detection: det ? {
        engine: det.engine || null,
        computedAt: det.computedAt || null,
        durationMs: det.durationMs || null,
        quality: typeof det.quality === 'number' ? Math.round(det.quality * 1e4) / 1e4 : null,
        coverage: typeof det.coverage === 'number' ? Math.round(det.coverage * 1e6) / 1e6 : null,
        primaryCoverage: typeof det.primaryCoverage === 'number'
          ? Math.round(det.primaryCoverage * 1e6) / 1e6 : null,
        primaryViewIndex: det.primaryViewIndex,
        frontOuterViewIndex: det.frontOuterViewIndex,
        frontInnerViewIndex: det.frontInnerViewIndex,
        backViewIndex: det.backViewIndex,
        viewRoleReviewRequired: !!det.viewRoleReviewRequired,
        axisConfidence: typeof det.axisConfidence === 'number'
          ? Math.round(det.axisConfidence * 1e4) / 1e4 : null,
        baselineConfidence: typeof det.baselineConfidence === 'number'
          ? Math.round(det.baselineConfidence * 1e4) / 1e4 : null,
        seamEvidence: det.seamEvidence ? clone(det.seamEvidence) : null,
        apexJoin: det.apexJoin ? clone(det.apexJoin) : null,
        cupModelId: det.cupModel && det.cupModel.id ? det.cupModel.id : null,
        thresholds: {
          ink: det.threshold != null ? det.threshold : null,
          luminance: det.luminanceThreshold != null ? det.luminanceThreshold : null,
          backgroundLum: det.backgroundLum != null ? det.backgroundLum : null,
        },
        detectionParams: det.detectionParams ? { ...det.detectionParams } : null,
        stageTimingsMs: det.stageTimingsMs ? { ...det.stageTimingsMs } : null,
        confidence: det.confidence ? { ...det.confidence } : null,
        componentCount: det.componentCount || 0,
        keptComponentCount: det.keptComponentCount || 0,
        views: Array.isArray(det.views) ? det.views.map(v => ({
          x: v.x, y: v.y, width: v.width, height: v.height,
          role: v.role, viewRole: v.viewRole,
          roleConfidence: v.roleConfidence,
        })) : [],
      } : null,
      anchors,
      learning,
      validation,
      cvDebug,
    };
  }

  // Trigger an in-browser download of the compact CV debug JSON. Used by the
  // ?cvDebug=1 inspector button and by the debug API. Returns the exported
  // payload (without the side effect) when document isn't available.
  function downloadCvDebugExport(imageName) {
    const payload = buildCvDebugExport(imageName);
    if (state.autoMode.cvDebug) state.autoMode.cvDebug.lastExport = payload;
    if (typeof document === 'undefined') return payload;
    const baseName = String(imageName || payload.image.name || 'cv-debug').replace(/[^\w.\-]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = (/\.json$/i.test(baseName) ? baseName.replace(/\.json$/i, '') : baseName)
      + '.cv-debug.' + stamp + '.json';
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (typeof showToast === 'function') {
        showToast('Saved CV debug: ' + fileName + ' (anchors=' + payload.anchors.length + ').');
      }
    } catch (err) {
      console.warn('[CV Debug] download failed:', err);
      if (typeof showToast === 'function') {
        showToast('Could not save CV debug file.', 4200);
      }
    }
    return payload;
  }

  // -------- Per-stage debug summary (Engineering Workflow, Phase 1) --------
  //
  // A compact, strictly READ-ONLY snapshot of what each pipeline stage produced
  // on the most recent Auto-Mode run. It maps the "segmentation -> contour ->
  // geometry -> landmark -> anchor" mental model in Engineering Workflow.md onto
  // the fields the current detector already emits, so an engineer or TD reviewer
  // can answer "did this stage do its job?" at a glance.
  //
  // This function only READS state.autoMode.detection / .anchors — it never
  // writes back, so it cannot alter detection output or drift golden. Fields
  // that the current pipeline does not yet compute cleanly are reported as null
  // with a `notes` entry rather than invented; those gaps are later phases
  // (e.g. a dedicated segmentation-quality score is Phase 3).
  function buildStageDebugSummary(imageName) {
    const det = state.autoMode.detection || null;
    const anchors = state.autoMode.anchors || [];
    const notes = [];
    const round = (v, digits) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      const f = Math.pow(10, digits || 4);
      return Math.round(v * f) / f;
    };

    if (!det) {
      return {
        generatedAt: new Date().toISOString(),
        image: imageName || null,
        ruleVersion: AUTO_RULE_VERSION,
        templateVersion: AUTO_TEMPLATE_VERSION,
        hasDetection: false,
        notes: ['No detection has run yet — run Detect Sketch first.'],
        segmentation: null,
        contour: null,
        geometry: null,
        landmarks: null,
        anchors: null,
        overall: null,
      };
    }

    // ---- Stage 2: Segmentation (ink mask separation) ----
    // Phase 3 made segmentation a first-class stage: det.segmentation carries a
    // normalized cross-backend result (backend id, bbox, deterministic quality,
    // and a weak-segmentation review flag). overall.quality remains the blended
    // detection quality (axis + band + chest), distinct from the mask score.
    const seg = det.segmentation || null;
    const segmentation = {
      // Normalized Phase-3 fields (null on very old captures without the block).
      backend: seg ? seg.backend : (det.segmentationBackend || null),
      quality: seg ? round(seg.quality, 4) : round(det.segmentationQuality, 4),
      weak: seg ? !!seg.weak : !!det.segmentationWeak,
      reviewRequired: seg ? !!seg.reviewRequired : !!det.segmentationReviewRequired,
      reasons: seg && Array.isArray(seg.reasons) ? seg.reasons.slice() : [],
      subScores: seg && seg.subScores ? { ...seg.subScores } : null,
      retainedInk: seg ? round(seg.retainedInk, 4) : null,
      rawCoverage: seg ? round(seg.rawCoverage, 6) : null,
      componentsBackend: seg ? seg.componentsBackend : null,
      inkCleanupReverted: seg ? !!seg.inkCleanupReverted : null,
      bbox: seg && seg.bbox ? { ...seg.bbox } : null,
      // Signals available before Phase 3 too.
      engine: det.engine || null,
      coverage: round(det.coverage, 6),
      primaryCoverage: round(det.primaryCoverage, 6),
      componentCount: det.componentCount || 0,
      keptComponentCount: det.keptComponentCount || 0,
      inkThreshold: det.threshold != null ? det.threshold : null,
      luminanceThreshold: det.luminanceThreshold != null ? det.luminanceThreshold : null,
      backgroundLum: det.backgroundLum != null ? det.backgroundLum : null,
      sampleWidth: det.sampleWidth || null,
      sampleHeight: det.sampleHeight || null,
      hasInkMask: !!det.inkMask,
    };
    if (segmentation.reviewRequired) {
      notes.push('segmentation.reviewRequired is set — weak mask quality (' + (segmentation.reasons.join('; ') || 'low score') + '); treat all POMs with extra scrutiny.');
    }

    // ---- Stage 3: Contour extraction (outlines / seams / junctions) ----
    // Phase 4 made this a clean CONTOUR-EVIDENCE bundle kept separate from
    // geometry decisions: type-split skeleton feature points (junctions /
    // endpoints / corners), deterministic stroke stats, and — once the deferred
    // Potrace trace runs — traced outlines plus reusable curve candidates.
    // contours/contourCount/curveCandidates only exist when the trace ran;
    // junctionSummary is the skeleton pass and is always attempted.
    const js = det.junctionSummary || null;
    const ce = det.contourEvidence || null;
    const contour = {
      contourCount: typeof det.contourCount === 'number' ? det.contourCount : null,
      traceDurationMs: typeof det.traceDurationMs === 'number' ? det.traceDurationMs : null,
      traceRan: !!det.contours,
      junctionPointCount: Array.isArray(det.junctions) ? det.junctions.length : 0,
      // Phase 4 evidence bundle (null on old captures without the block).
      endpointCount: Array.isArray(det.endpoints) ? det.endpoints.length
        : (ce ? (ce.endpointCount || 0) : null),
      cornerCount: Array.isArray(det.corners) ? det.corners.length
        : (ce ? (ce.cornerCount || 0) : null),
      curveCandidateCount: Array.isArray(det.curveCandidates) ? det.curveCandidates.length
        : (ce ? (ce.curveCandidateCount || 0) : 0),
      strokeStats: det.strokeStats ? { ...det.strokeStats }
        : (ce && ce.strokeStats ? { ...ce.strokeStats } : null),
      junctionSummary: js ? {
        junctions: js.junctions || 0,
        endpoints: js.endpoints || 0,
        corners: js.corners || 0,
        skeletonPx: js.skeletonPx || 0,
        thinningIterations: js.thinningIterations || 0,
        prunedSpurs: js.prunedSpurs || 0,
        capped: !!js.capped,
      } : null,
    };
    if (contour.contourCount == null) {
      notes.push('contour.contourCount is null: the Potrace vector trace did not run for this detection (contours are optional shape evidence).');
    }

    // ---- Stage 4: Geometry analysis (axis / band / views) ----
    const geometry = {
      bbox: det.bbox ? { ...det.bbox } : null,
      axisX: round(det.axisX, 4),
      bandY: round(det.bandY, 4),
      chestY: round(det.chestY, 4),
      cradleY: round(det.cradleY, 4),
      sideLeftX: round(det.sideLeftX, 4),
      sideRightX: round(det.sideRightX, 4),
      symmetry: round(det.symmetry, 4),
      axisConfidence: round(det.axisConfidence, 4),
      baselineConfidence: round(det.baselineConfidence, 4),
      viewCount: Array.isArray(det.views) ? det.views.length : 0,
      primaryViewIndex: det.primaryViewIndex,
      frontOuterViewIndex: det.frontOuterViewIndex,
      frontInnerViewIndex: det.frontInnerViewIndex,
      backViewIndex: det.backViewIndex,
      viewRoleReviewRequired: !!det.viewRoleReviewRequired,
      views: Array.isArray(det.views) ? det.views.map(v => ({
        role: v.role || v.viewRole || null,
        roleConfidence: v.roleConfidence != null ? v.roleConfidence : null,
      })) : [],
      // Phase 5: the explicit geometry-fact bundle (center axis, band line, cup
      // curves, strap candidates, back-panel candidates, and view regions with
      // roles + confidence), plus the geometry-quality review verdict. This is
      // produced by the geometry stage BEFORE anchor placement — the seed layer
      // reads these roles, it does not re-derive them. Null on old captures.
      geometryFacts: det.geometryFacts ? clone(det.geometryFacts) : null,
      geometryReviewRequired: !!det.geometryReviewRequired,
    };
    if (geometry.geometryReviewRequired) {
      const reasons = det.geometryFacts && det.geometryFacts.quality
        && Array.isArray(det.geometryFacts.quality.reasons)
        ? det.geometryFacts.quality.reasons.join('; ')
        : 'weak geometry';
      notes.push('geometry.geometryReviewRequired is set — ' + (reasons || 'weak geometry') + '; the affected landmarks are flagged for TD review.');
    }

    // ---- Stage 5: Landmark detection (technical points + confidence) ----
    // Phase 6 made this a first-class layer: det.landmarkQa classifies every
    // anchor-schema kind (source class, tier, review verdict, QA notes) before
    // anchor placement. Seeding recomputes and re-attaches it, so it reflects
    // the verdicts the current anchors actually consumed; for a detection that
    // has not been seeded yet (or an old capture) it is rebuilt read-only here.
    const lq = det.landmarkQa
      || (typeof buildLandmarkQaFromDetection === 'function'
        ? buildLandmarkQaFromDetection(det)
        : null);
    const landmarks = {
      confidenceByKind: det.confidence ? { ...det.confidence } : null,
      seamEvidence: det.seamEvidence ? clone(det.seamEvidence) : null,
      apexJoin: det.apexJoin ? clone(det.apexJoin) : null,
      cupModelId: det.cupModel && det.cupModel.id ? det.cupModel.id : null,
      cupVisibility: det.cupModel && det.cupModel.visibility ? det.cupModel.visibility : null,
      // Phase 6 landmark QA layer (per anchor-schema kind).
      qaByKind: lq ? clone(lq.byKind) : null,
      qaSummary: lq ? clone(lq.summary) : null,
      cupGate: lq ? clone(lq.cupGate) : null,
    };
    if (lq) {
      if (lq.summary.missing > 0) {
        const missingKinds = Object.keys(lq.byKind).filter(k => !lq.byKind[k].present);
        notes.push('landmarks: ' + lq.summary.missing + ' kind(s) missing (' + missingKinds.join(', ') + ') — their POMs demote to REVIEW_ONLY rather than fake certainty.');
      }
      notes.push('landmarks.qaByKind: ' + lq.summary.reviewRequired + '/' + lq.summary.total + ' kinds flagged reviewRequired (sources: '
        + lq.summary.bySourceClass.detected + ' detected, '
        + lq.summary.bySourceClass.derived + ' derived, '
        + lq.summary.bySourceClass.projected + ' projected, '
        + lq.summary.bySourceClass.missing + ' missing).');
    } else {
      notes.push('landmarks.qaByKind unavailable: this capture predates the Phase 6 landmark QA layer.');
    }

    // ---- Stage 6: Anchor placement (normalized [0,1] anchors) ----
    const tierCounts = { high: 0, medium: 0, low: 0, none: 0 };
    const sourceCounts = {};
    let reviewRequiredCount = 0;
    const anchorList = anchors.map(a => {
      const tier = a.confidence || 'none';
      if (Object.prototype.hasOwnProperty.call(tierCounts, tier)) tierCounts[tier] += 1;
      else tierCounts[tier] = (tierCounts[tier] || 0) + 1;
      const src = a.source || 'unknown';
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      if (a.reviewRequired) reviewRequiredCount += 1;
      return {
        kind: a.kind,
        confidence: a.confidence || null,
        source: a.source || null,
        reviewRequired: !!a.reviewRequired,
        autoFilled: !!a.autoFilled,
        calibrated: !!a.calibrated,
        viewRole: a.viewRole || null,
      };
    });
    const anchorSummary = {
      count: anchorList.length,
      reviewRequiredCount,
      byConfidenceTier: tierCounts,
      bySource: sourceCounts,
      anchors: anchorList,
    };

    const overall = {
      quality: round(det.quality, 4),
      segmentationQuality: segmentation.quality,
      segmentationReviewRequired: segmentation.reviewRequired,
      durationMs: det.durationMs != null ? det.durationMs : null,
      computedAt: det.computedAt || null,
      stageTimingsMs: det.stageTimingsMs ? { ...det.stageTimingsMs } : null,
      validationStatus: state.autoMode.validation ? (state.autoMode.validation.status || null) : null,
    };

    return {
      generatedAt: new Date().toISOString(),
      image: imageName || (det.sourceImageId || null),
      ruleVersion: AUTO_RULE_VERSION,
      templateVersion: AUTO_TEMPLATE_VERSION,
      hasDetection: true,
      segmentation,
      contour,
      geometry,
      landmarks,
      anchors: anchorSummary,
      overall,
      notes,
    };
  }
