// Debug / introspection APIs for offline tooling. Source part for app.js.
// Run `npm run build` after editing.
//
// exportGroundTruth/downloadGroundTruth emit a normalized anchor JSON for
// scripts/accuracy-tests.mjs. buildCvDebugExport/downloadCvDebugExport
// dump the intermediate CV pipeline state captured by runOfflineDetection
// when window.__braAutoModeDebug.cv.setEnabled(true) is on (or ?cvDebug=1).

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

  if (typeof window !== 'undefined') {
    window.__braAutoModeDebug = {
      // Pure detection pipeline stages, exposed so each can be driven with
      // synthetic input and timed independently. Side effects (canvas reads,
      // state writes, toasts) live in runOfflineDetection, not here.
      pipeline: {
        readSourceImagePixels: (img, targetWidth) => readSourceImagePixels(img, targetWidth),
        pixelsToLegacyInkAnalysis: (pixels, w, h) => pixelsToLegacyInkAnalysis(pixels, w, h),
        detectSketchFromInkAnalysis: (cvAnalysis, opts) => detectSketchFromInkAnalysis(cvAnalysis, opts || {}),
        // Skeleton junction / endpoint / corner pass (Phase 1, plan 2).
        // Pure typed-array work — scripts/junction-tests.mjs drives it with
        // synthetic masks, no Chrome needed.
        detectJunctions: (mask, w, h, opts) => detectJunctions(mask, w, h, opts),
        // Derived-anchor cascade (Phase 3, plan 2). Pure — tests feed an
        // anchor list and assert dependents follow their primaries.
        deriveAnchors: (anchors, opts) => deriveAnchors(anchors, opts),
        seedAnchorsFromDetection: (detection, sourceImage, options) =>
          seedAnchorsFromDetection(detection, sourceImage, options),
        // Headless-Chrome-free POM-fixture builder. Tests pass an anchor list
        // and the matching detection so the closure that reads
        // state.autoMode.detection (for cradle/cradleCfTop signals) sees the
        // same numbers a real run would.
        buildPOMFixtureFromAnchors: (anchorList, detectionForTest) => {
          const prev = state.autoMode.detection;
          if (detectionForTest !== undefined) state.autoMode.detection = detectionForTest;
          try {
            return buildPOMFixtureFromAnchors(anchorList);
          } finally {
            state.autoMode.detection = prev;
          }
        },
        validateAutoFixture: (fixture, detectionForTest) => {
          const prev = state.autoMode.detection;
          if (detectionForTest !== undefined) state.autoMode.detection = detectionForTest;
          try {
            return validateAutoFixture(fixture);
          } finally {
            state.autoMode.detection = prev;
          }
        },
      },
      getDetection: () => {
        const det = state.autoMode.detection;
        if (!det) return null;
        // Drop the binary ink mask (U2 snap-to-ink working data): JSON-cloning
        // a Uint8Array would explode it into one key per pixel. Expose its
        // dimensions so tests can assert it was retained.
        const { inkMask, ...rest } = det;
        return Object.assign(clone(rest), { hasInkMask: !!inkMask });
      },
      // Read-only per-stage debug summary (Engineering Workflow, Phase 1):
      // segmentation quality signals, contour/junction counts, geometry facts,
      // landmark confidence, and anchor confidence for the most recent run.
      // Pure read of state.autoMode.detection/.anchors — never mutates them, so
      // it cannot affect detection output.
      getStageSummary: (name) => clone(buildStageDebugSummary(name)),
      // Phase 3 segmentation seam. A registered adapter is tried FIRST in the
      // segmentation stage; it must return the built-in ink-analysis shape and
      // MUST run fully offline (no network call carrying sketch/measurement
      // data). Default is unregistered, so the runtime is unchanged until a
      // caller opts in. clear() restores the built-in OpenCV / legacy path.
      segmentation: {
        registerAdapter: (fn) => registerSegmentationAdapter(fn),
        clearAdapter: () => clearSegmentationAdapter(),
        hasAdapter: () => !!getSegmentationAdapter(),
      },
      getAnchors: () => clone(state.autoMode.anchors),
      // Board viewport, so UI-level tests can convert an anchor's world
      // position (image rect + normalized anchor) into canvas screen
      // coordinates for synthetic mouse events.
      getViewport: () => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
      // Ground-truth export for scripts/accuracy-tests.mjs. Returns the
      // current anchors keyed by kind in normalized image space.
      exportGroundTruth: (name) => clone(exportGroundTruth(name)),
      getDrafts: () => clone(state.autoMode.draftAnnotations),
      getImages: () => state.images.map(image => ({
        id: image.id,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      })),
      // US-082 toolbar test seam: add decoded Board image data without also
      // invoking detection. This isolates the ready-state toolbar contract;
      // the smoke/golden suites continue to own detection proof.
      addBoardImages: async (dataURLs) => {
        await addImagesFromDataURLs(Array.isArray(dataURLs) ? dataURLs : []);
        return {
          imageCount: state.images.length,
          status: state.autoMode.status,
        };
      },
      getAnnotations: () => clone(state.annotations),
      // Test-only: set the review-time hidden POM lines by annotation id — the
      // same session-only state the panel's × toggle writes (state.hiddenAnnIds).
      // Lets the export suite assert hidden lines are omitted from the spec
      // without faking clicks. Not persisted, mirroring the UI it stands in for.
      setHiddenAnnIds: (ids) => {
        state.hiddenAnnIds = Array.isArray(ids) ? ids.slice() : [];
        if (typeof renderSpecPanel === 'function') renderSpecPanel();
        if (typeof requestRender === 'function') requestRender();
        return clone(state.hiddenAnnIds);
      },
      // Tier-0 library-value suggestions (scripts/suggestions-tests.mjs).
      // getPomSuggestions: the raw per-POM corpus stats loaded into scope.
      // getEffectivePomSpec: the panel's effective spec for a POM (TD override
      //   if any, else the library suggestion) — proves the fallback + export
      //   path. setPomSpecOverride: set a TD override and re-render, returning
      //   the new effective spec so a test can assert override wins.
      getPomSuggestions: () => clone(POM_SUGGESTIONS),
      getEffectivePomSpec: (key) => (typeof getPomSpec === 'function' ? clone(getPomSpec(key)) : null),
      setPomSpecOverride: (key, field, value) => {
        const changed = setPomSpec(key, field, value);
        if (changed) pushHistoryIfChanged();
        if (typeof renderSpecPanel === 'function') renderSpecPanel();
        return clone(getPomSpec(key));
      },
      // Export image paths honor hidden POMs (scripts/export-hidden-tests.mjs).
      // getExportAnnIds: the exact applied-annotation set the export renderers
      //   (PDF / Copy Image / Excel embedded PNG) draw and crop from, so a test
      //   can assert a hidden POM is dropped without a real canvas.
      // exportBoardDataUrl: the rendered export board as a PNG data URL, for
      //   visual verification that a hidden line's pixels are gone.
      getExportAnnIds: () => (typeof visibleExportAnnotations === 'function'
        ? visibleExportAnnotations().map(a => a.id) : null),
      exportBoardDataUrl: () => {
        if (typeof getContentBounds !== 'function' || typeof renderBoardRegionToCanvas !== 'function') return null;
        const bounds = getContentBounds();
        if (!bounds) return null;
        return renderBoardRegionToCanvas(bounds).toDataURL('image/png');
      },
      // Canvas view transform. Needed to drive REAL pointer events from world
      // coordinates in a test (screenX = worldX * zoom + panX + canvasRect.left),
      // which is the only way to exercise selection, drag and resize the way a TD
      // does. Without it a UI test has to guess pixel positions.
      getView: () => ({ zoom: state.zoom, panX: state.panX, panY: state.panY }),
      getAcceptanceStats: () => clone(getAutoAcceptanceStats()),
      clearAcceptanceStats: () => clearAutoAcceptanceStats(),
      getTelemetryLog: () => clone(getAutoTelemetryLog()),
      getTelemetryReport: (limit) => clone(getAutoTelemetryReport(limit || 10)),
      clearTelemetryLog: () => clearAutoTelemetryLog(),
      runAutoOnDataUrl: async (dataURL, opts) => {
        // Opt-in CV debug capture per-call. When opts.cvDebug is true, the
        // CV debug flag is flipped on before detection so the resulting
        // detection.debug payload is populated for the caller to inspect.
        if (opts && opts.cvDebug) {
          if (!state.autoMode.cvDebug) {
            state.autoMode.cvDebug = { enabled: false, lastDebug: null, lastExport: null };
          }
          state.autoMode.cvDebug.enabled = true;
        }
        setAppMode('auto');
        await addImagesFromDataURLs([dataURL]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sourceImage = state.images[state.images.length - 1] || null;
        if (!sourceImage) throw new Error('No image was added.');
        // opts.auxDataURLs: add EXTRA board photos (e.g. a separate front-inner
        // cutaway) before detection, so a suite can exercise the real 2-image board
        // a TD uses. Until this existed every suite ran a single image, which is why
        // the aux-view path could regress with all suites green (ADR 0036 follow-up).
        // The primary image stays the detection source; extras become aux views.
        const auxDataURLs = (opts && Array.isArray(opts.auxDataURLs)) ? opts.auxDataURLs : [];
        if (auxDataURLs.length) {
          await addImagesFromDataURLs(auxDataURLs);
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        state.selection = { kind: 'image', id: sourceImage.id };
        await runOfflineDetection();
        generatePOMDraftsFromAnchors({ keepDraftsForReview: true, suppressReplacePrompt: true });
        return {
          state: window.__braAutoModeDebug.getState(),
          images: window.__braAutoModeDebug.getImages(),
          detection: window.__braAutoModeDebug.getDetection(),
          anchors: window.__braAutoModeDebug.getAnchors(),
          drafts: window.__braAutoModeDebug.getDrafts(),
          cvDebug: window.__braAutoModeDebug.cv.getLastDebug(),
          cvExport: window.__braAutoModeDebug.cv.exportDebug(sourceImage.id),
        };
      },
      approveDrawableDrafts: () => {
        const targets = state.autoMode.draftAnnotations
          .filter(d => !isReviewOnlyDraft(d) && !d.tdApproved);
        for (const draft of targets) approveDraftAnnotation(draft);
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        return targets.length;
      },
      applyApprovedDrafts: () => applyApprovedDraftsAtomically({ suppressPrompt: true }),
      exportProject: () => clone(buildProjectSnapshot()),
      /* US-080: drives a MAIN PAGE sketch slot the way the upload/paste menu
         does, and hands back the RAW runtime state.mainPage — the one history
         clones — so a suite can prove the image bytes never land in it. */
      setMainPageSketch: async (variant, index, dataURL) => {
        if (typeof mpSetSketch !== 'function') return null;
        await mpSetSketch(variant, index, dataURL);
        return JSON.stringify(state.mainPage);
      },
      loadProject: async (project) => {
        await loadProject(project);
        return window.__braAutoModeDebug.getState();
      },
      // Autosave hooks — only intended for end-to-end tests that need
      // to force a write without simulating a live edit cycle.
      autosave: {
        flush: () => (typeof flushAutosave === 'function' ? flushAutosave() : null),
        peek: () => {
          try { return localStorage.getItem('bra-sketch-autosave-v1'); }
          catch (_) { return null; }
        },
        clear: () => (typeof clearAutosave === 'function' ? clearAutosave() : null),
      },
      getState: () => ({
        appMode: state.appMode,
        activePage: state.activePage,
        autoStatus: state.autoMode.status,
        lastError: state.autoMode.lastError,
        validation: clone(state.autoMode.validation),
        imageCount: state.images.length,
        draftCount: state.autoMode.draftAnnotations.length,
        anchorCount: state.autoMode.anchors.length,
      }),
      // CV debug surface. Toggles intermediate detector state capture and
      // hands tests a compact JSON snapshot they can diff. Pure orthogonal
      // to learning / meaning — only intermediate detector signals.
      cv: {
        isEnabled: () => !!(state.autoMode.cvDebug && state.autoMode.cvDebug.enabled),
        setEnabled: (on) => {
          if (!state.autoMode.cvDebug) {
            state.autoMode.cvDebug = { enabled: false, lastDebug: null, lastExport: null };
          }
          state.autoMode.cvDebug.enabled = !!on;
          if (!state.autoMode.cvDebug.enabled) state.autoMode.cvDebug.lastDebug = null;
          return state.autoMode.cvDebug.enabled;
        },
        getLastDebug: () => clone(state.autoMode.cvDebug && state.autoMode.cvDebug.lastDebug),
        clearLastDebug: () => {
          if (state.autoMode.cvDebug) {
            state.autoMode.cvDebug.lastDebug = null;
            state.autoMode.cvDebug.lastExport = null;
          }
        },
        // Compact JSON snapshot — anchors + thresholds + learned params +
        // validation warnings + (when CV debug was on) the full intermediate
        // capture. Safe to call any time after Detect Sketch.
        exportDebug: (imageName) => clone(buildCvDebugExport(imageName)),
        // Browser-only: triggers a Blob download of the export JSON.
        downloadDebug: (imageName) => clone(downloadCvDebugExport(imageName)),
      },
      // Learning-mode test surface. Lets scripts/learning-tests.mjs
      // drive recordAnchorResidual / getAnchorBias / the on-off toggle
      // without touching the DOM or window.confirm. Not used by the
      // app itself — purely a CDP hook for the test runner.
      learning: {
        isEnabled: () => isLearningEnabled(),
        setEnabled: (on) => { setLearningEnabled(!!on); },
        recordResidual: (kind, dx, dy, anchor) => recordAnchorResidual(kind, dx, dy, anchor),
        // Phase 8: stage attribution for a hypothetical correction, without
        // recording it — lets the learning suite assert the classifier.
        classifyResidual: (kind, dx, dy) => classifyResidualStage(kind, dx, dy),
        getBias: (kind, anchor) => clone(getAnchorBias(kind, anchor)),
        getSampleCount: () => getLearningSampleCount(),
        getBuckets: () => clone(learningStore.buckets),
        getParamSamples: () => clone(learningStore.paramSamples || {}),
        getDetectionParams: () => clone(getLearnedDetectionParams()),
        summarize: () => clone(summarizeLearningStore()),
        clearBuckets: () => {
          learningStore = emptyLearningStore();
          saveLearningStore();
          clearManualLearnCache();
        },
        applyBiasTo: (anchors) => clone(applyLearningBiasToAnchors(clone(anchors))),
        evaluateSample: (ann) => {
          const result = evaluateManualPomSample(ann);
          // Surface the status + hash so a follow-up call can confirm
          // the same hash is now considered a duplicate.
          return {
            status: result.status,
            pom: result.pom || null,
            hash: result.hash || null,
            annHash: ann.learnSampleHash || null,
          };
        },
        evaluateAutoAppliedSample: (ann) => {
          const result = evaluateManualPomSample(ann, { allowAuto: true });
          return {
            status: result.status,
            pom: result.pom || null,
            hash: result.hash || null,
            annHash: ann.learnSampleHash || null,
          };
        },
      },
      // Meaning-aware learning test surface. scripts/meaning-tests.mjs
      // drives the (style, POM) catalog and the confirmation flow without
      // touching the DOM. Keeping it here so the meaning helpers stay
      // private to auto-drafts.js but a runner can still poke at them.
      meaning: {
        getStore: () => clone(meaningStore),
        clearAll: () => { clearMeaningStore('all'); },
        clearCurrent: () => { clearMeaningStore('current'); },
        setStyleId: (id) => { state.styleId = (id == null ? '' : String(id)); },
        getStyleId: () => state.styleId || '',
        currentStyleBucketId: () => currentStyleId(),
        resolve: (pom) => {
          const m = resolvePomMeaning(String(pom));
          return m ? clone(m) : null;
        },
        confirm: (pom, meaningId) => { confirmPomMeaning(String(pom), meaningId); },
        forget: (pom, styleId) => forgetPomMeaning(String(pom), styleId),
        listForStyle: (styleId) => clone(listConfirmedMeanings(styleId || currentStyleId())),
        summarize: () => clone(summarizeMeaningStore()),
        knownStyles: () => listKnownStyleIds(),
        catalog: () => clone(getAllCatalogMeanings()),
        addCustom: (label, startAnchor, endAnchor) => {
          const entry = addCustomMeaning(label, startAnchor, endAnchor);
          return entry ? clone(entry) : null;
        },
        usagePriority: (meaningId) => meaningUsagePriority(meaningId),
        suggest: (ann, limit) => {
          const image = pickImageForAnnotation(ann);
          if (!image) return [];
          return clone(rankCatalogForLine(image, ann, limit || 3));
        },
        // Run the full evaluate → commit cycle from a script. Returns the
        // eval result + the final ann.learnSampleHash so callers can
        // check whether the sample was actually recorded.
        commitChoice: (ann, meaningId) => {
          const evalResult = evaluateManualPomSample(ann);
          if (evalResult.status !== 'needsConfirmation') {
            return { status: evalResult.status, pom: evalResult.pom || null, applied: false };
          }
          const ok = commitMeaningChoice(evalResult, meaningId);
          return {
            status: ok ? 'recorded' : 'skipped',
            pom: evalResult.pom || null,
            applied: ok,
            meaningId,
          };
        },
        commitCustom: (ann, label) => {
          const evalResult = evaluateManualPomSample(ann);
          if (evalResult.status !== 'needsConfirmation') {
            return { status: evalResult.status, pom: evalResult.pom || null, applied: false };
          }
          const ok = commitMeaningChoiceCustom(evalResult, label);
          return {
            status: ok ? 'recorded' : 'skipped',
            pom: evalResult.pom || null,
            applied: ok,
            label,
          };
        },
        // Force-set a usage record so recency tests can synthesize an
        // "I confirmed this 100 days ago" history without waiting.
        seedUsage: (meaningId, count, lastUsedAt) => {
          if (!meaningId) return false;
          meaningStore.usage[meaningId] = {
            count: Number(count) || 0,
            lastUsedAt: Number(lastUsedAt) || 0,
          };
          saveMeaningStore();
          return true;
        },
        // Popover + canvas inspection — these reach into manual-tools.js
        // through the shared IIFE scope (the bundle wraps every source
        // part in the same closure). Keeping them here keeps the test
        // surface in one namespace.
        getCanvasTool: () => state.tool,
        setAppMode: (mode) => { setAppMode(mode === 'auto' ? 'auto' : 'manual'); },
      },
      // Style evidence test surface. Read-only Phase 1 store — scripts
      // can list/summarize/add/forget without touching the DOM. Kept
      // alongside learning and meaning so a test runner sees one
      // namespace per durable store.
      styleEvidence: {
        getStore: () => clone(styleEvidenceStore),
        list: (styleId) => clone(listStyleEvidence(styleId || currentStyleId())),
        summarize: (styleId) => clone(summarizeStyleEvidence(styleId || currentStyleId())),
        add: (styleId, record) => {
          const out = addStyleEvidence(styleId || currentStyleId(), record);
          return out ? clone(out) : null;
        },
        forget: (styleId, evidenceId) =>
          forgetStyleEvidence(styleId || currentStyleId(), evidenceId),
        clearAll: () => clearStyleEvidence('all'),
        clearStyle: (styleId) => clearStyleEvidence('style', styleId || currentStyleId()),
        knownStyles: () => listKnownEvidenceStyleIds(),
        // Phase 2 capture path. Tests can preview the candidate list and
        // commit it without driving the dialog — the save flow uses the
        // same two helpers under the hood.
        collectCandidates: (styleId) =>
          clone(collectStyleEvidenceCandidates(styleId)),
        commitCandidates: (styleId, candidates) =>
          commitStyleEvidenceCandidates(styleId || currentStyleId(), candidates || []),
        applyAbsenceToDrafts: (drafts) => {
          const copied = clone(drafts || []);
          applyStyleAbsenceEvidenceToDrafts(copied);
          return copied;
        },
        // Confirmed-evidence reuse: returns the drafts after the soft
        // blend toward the median of recent TD-confirmed lines for the
        // current style. Caller passes the source image so we can convert
        // normalized evidence into world coords.
        applyConfirmedToDrafts: (drafts, sourceImage) => {
          const copied = clone(drafts || []);
          applyStyleConfirmedEvidenceToDrafts(copied, sourceImage);
          return copied;
        },
        confirmedMedians: (styleId) => {
          const map = getConfirmedEvidenceMediansByPom(styleId || currentStyleId());
          const out = {};
          for (const [pom, value] of map.entries()) out[pom] = clone(value);
          return out;
        },
        // Test-only: push a synthetic annotation into state.annotations
        // so collectCandidates can see it. Used by the manual-confirmed
        // path test, which needs a real annotation in the project (not
        // just a synthetic ann passed through the meaning popover).
        // Returns the inserted annotation id.
        pushAnnotation: (ann) => {
          if (!ann || typeof ann !== 'object') return null;
          state.annotations.push(ann);
          return ann.id;
        },
        // Test-only: simulate a TD edit on one applied auto annotation
        // by id. Optional `patch` overrides specific endpoints in world
        // coordinates so the harness can verify normalization without
        // having to fake mouse interactions.
        simulateTdEdit: (annotationId, patch) => {
          const ann = state.annotations.find(a => a && a.id === annotationId);
          if (!ann) return null;
          ann.tdEdited = true;
          if (patch && typeof patch === 'object') {
            if (patch.start && typeof patch.start === 'object') {
              ann.start = { x: Number(patch.start.x), y: Number(patch.start.y) };
            }
            if (patch.end && typeof patch.end === 'object') {
              ann.end = { x: Number(patch.end.x), y: Number(patch.end.y) };
            }
          }
          return clone(ann);
        },
        simulateTdDelete: (annotationId) => {
          const ann = state.annotations.find(a => a && a.id === annotationId);
          if (!ann) return null;
          markDeletedAutoAnnotationForEvidence(ann);
          state.annotations = state.annotations.filter(a => a && a.id !== annotationId);
          if (state.selection.kind === 'annotation' && state.selection.id === annotationId) {
            state.selection = { kind: null, id: null };
          }
          return clone(ann);
        },
      },
    };
  }
