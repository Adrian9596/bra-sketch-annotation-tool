// Debug / introspection export builders for offline tooling. Source part
// for app.js. Run `npm run build` after editing.
//
// exportGroundTruth/downloadGroundTruth emit a normalized anchor JSON for
// scripts/accuracy-tests.mjs (the ?label=1 labeling button). buildCvDebugExport
// dumps the intermediate CV pipeline state captured by runOfflineDetection
// when window.__braAutoModeDebug.cv.setEnabled(true) is on (or ?cvDebug=1).
//
// The window.__braAutoModeDebug facade (the sibling src/debug/debug-api.js,
// which loads after this file) exposes buildCvDebugExport as cv.exportDebug;
// downloadGroundTruth is wired by src/app/url-bootstrap.js.

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
  // ?label=1 labeling button (see maybeShowGroundTruthLabeler in src/app/url-bootstrap.js).
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
  //   - detection params (effective)
  //   - threshold values + per-stage timing
  //   - detected anchors with normalized position + confidence tier
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
      source: a.source || null,
      reviewRequired: !!a.reviewRequired,
      cupModelId: a.cupModelId || null,
    }));
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
      validation,
      cvDebug,
    };
  }
