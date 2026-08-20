// Stage 5 of the detection pipeline: landmark construction. ONE readable
// sequence showing everything the detector decides, in order — apex / strap
// orchestration, the POM 6 and POM 7 seam calls, the cup model and back-landmark
// call sites, per-feature confidence and overall quality, the assembled
// detectionResult, the geometryFacts completion with its geometry-quality
// verdict, the landmark-QA attach, and the opt-in CV-debug payload.
//
// The work itself lives in the sibling parts this stage calls into:
// src/auto/detect/front-landmarks.js, src/auto/detect/back-landmarks.js,
// src/auto/detect/cup-model.js, src/auto/detect/pom6-cradle-cf.js,
// src/auto/detect/pom7-cradle-cup.js, src/auto/detect/cv-debug-payload.js and
// src/auto/detect/landmark-qa.js — so this part must load after all of them.
// Its caller is the pipeline composer in src/auto-detection.js.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Stage 5: landmark construction (+ confidence + assembly) ----
  // Input: segmentation output, geometry facts, and the contour/topology map.
  // Output: the assembled detection result the rest of the app consumes —
  // apex/strap/inner-cup/side/back landmarks, the cup model, per-feature
  // confidence, overall quality, seam evidence, view metadata, and (when
  // requested) the layered CV-debug payload. Landmarks carry technical
  // meaning; normalization to anchors happens later in the anchor seed layer.
  function detectLandmarks(cvAnalysis, seg, geometry, contours, ctx) {
    const { detectionParams, debugEnabled, stageTimingsMs } = ctx;
    const _stageMark = ctx.mark;
    const { rawStats, inkCleanupReverted, segmentation } = seg;
    // Contour-evidence bundle (Phase 4). junctionMap keeps the unchanged
    // detection.junctions / junctionSummary contract; endpoints / corners /
    // strokeStats are the reusable shape evidence, exposed additively.
    const { junctionMap } = contours;
    const contourEndpoints = contours.endpoints || [];
    const contourCorners = contours.corners || [];
    const contourStrokeStats = contours.strokeStats || null;
    const {
      dark, rawDark, w, h, total, filtered, globalStats,
      threshold, luminanceThreshold,
      viewBoxesPx, viewClassification, primaryViewIndex, darkCount,
      minX, minY, maxX, maxY, bbox, bboxW, bboxH,
      axisXpx, axisX, symmetry, axisPx,
      rowNoiseFloor, colNoiseFloor,
      bandStart, bandRow, bandStrength, bandPreferred, bandEdgeRow, bandY,
      chestRow, chestStrength, chestY,
      peakSep, cradleRow, cradleStrength, cradleY,
      underbustRow, underbustStrength, minRowSpan, underbustRunPx, underbustY,
      medianRow, medianCol, innerLo, innerHi, axisGuard,
      sideLeftCol, sideLeftStrength, sideLeftX,
      sideRightCol, sideRightStrength, sideRightX,
      geometryFacts,
    } = geometry;

    // ---- Stage: apex + strap landmarks ----
    const bounds = { minX, minY, maxX, maxY };

    // POM 6 / POM 7 bottom anchors follow the drawn hem at their OWN column
    // instead of the single flat bandY row (US-061). Normalized result, with
    // the flat row as the fallback when that column carries no ink — so a
    // straight-hem sketch is byte-identical to before.
    const hemNormAtColumn = (colPx, flatY) => {
      const row = hemRowAtColumn(dark, w, h, colPx, bandY * h, bboxH);
      return row == null ? flatY : row / h;
    };
    // The CF column's hem — POM 6's (and, unavoidably, POM 5's) bottom.
    const cfBottomHemY = hemNormAtColumn(axisPx, bandY);
    const apexLeftCandidate = findCupStrapJoinFromInk(dark, w, h, bounds, axisPx, chestRow, -1);
    const apexRightCandidate = findCupStrapJoinFromInk(dark, w, h, bounds, axisPx, chestRow, +1);
    // US-084: the two cup/strap joins are near-symmetric features, so a pair
    // that disagrees sharply on row means one side locked onto the wrong ink —
    // and the sides are found INDEPENDENTLY, so nothing above caught that. Give
    // the outlier side a second look, anchored on the side we trust.
    const apexRepaired = repairApexPairRow(
      apexLeftCandidate, apexRightCandidate, dark, w, h, bounds, axisPx, chestRow);
    const apexPair = validateCupApexPair(apexRepaired.left, apexRepaired.right, bounds, w, h);
    const apexLeftInfo = apexPair ? apexPair.left : null;
    const apexRightInfo = apexPair ? apexPair.right : null;
    const apexLeft = apexLeftInfo ? apexLeftInfo.point : null;
    const apexRight = apexRightInfo ? apexRightInfo.point : null;
    // Inner-edge apex points (POM 16 measures inner-edge to inner-edge of the
    // cup/front-strap joining seams). Falls back to the join center when the
    // ink run didn't yield an inner edge.
    const apexLeftInner = (apexLeftInfo && apexLeftInfo.innerEdgeX != null)
      ? { x: apexLeftInfo.innerEdgeX, y: apexLeftInfo.point.y }
      : apexLeft;
    const apexRightInner = (apexRightInfo && apexRightInfo.innerEdgeX != null)
      ? { x: apexRightInfo.innerEdgeX, y: apexRightInfo.point.y }
      : apexRight;
    // Outer-edge apex points (POM 14's fallback strap join sits on the OUTER
    // edge of the cup/strap join — ADR 0017, TD correction 2026-07-10).
    const apexLeftOuter = (apexLeftInfo && apexLeftInfo.outerEdgeX != null)
      ? { x: apexLeftInfo.outerEdgeX, y: apexLeftInfo.point.y }
      : apexLeft;
    const apexRightOuter = (apexRightInfo && apexRightInfo.outerEdgeX != null)
      ? { x: apexRightInfo.outerEdgeX, y: apexRightInfo.point.y }
      : apexRight;
    const strapInfo = findStrapLandmarksFromInk(dark, w, h, bounds, axisPx, chestRow);
    // POM 14 starts at the upper joining seam of the stitched section of the
    // FRONT RIGHT shoulder strap (TD-corrected, ADR 0016: the strap adjacent
    // to the back view, so the drawn curve follows one continuous strap over
    // the shoulder). This is a separate semantic landmark from strapInfo.top
    // (the topmost strap ink) and from the back strap/panel join.
    const frontStrapStartInfo = findFrontStrapStartFromInk(
      dark, w, h, bounds, apexRightInfo || apexLeftInfo, chestRow);

    _stageMark('apexStrap');

    // ---- Stage: inner-cup top + side-seam top (audit POMs 9, 10, 11) ----
    const innerCupTopInfo = findInnerCupTopFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow);
    const sideTopLeftInfo = findSideTopFromInk(dark, w, h, bounds, sideLeftCol, chestRow, -1);
    const sideTopRightInfo = findSideTopFromInk(dark, w, h, bounds, sideRightCol, chestRow, +1);
    const sideBottomRightInfo = sideTopRightInfo
      ? findSideBottomFromInk(dark, w, h, bounds, sideTopRightInfo.point)
      : null;

    _stageMark('innerCupAndSideTop');

    // ---- Stage: front-view ink endpoints (chest L/R, band L/R, CF top) ----
    // The pipeline already detects chest/band ROWS from ink; walk along those
    // rows to find the ink ENDPOINTS too so chest-left/right and band-left/
    // right snap to actual line ends instead of view-box corners.
    const halfRowBand = Math.max(2, Math.round(bboxH * 0.012));
    const halfColBand = Math.max(2, Math.round(bboxW * 0.018));
    const chestLeftPx  = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, minX, maxX, +1) : -1;
    const chestRightPx = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, maxX, minX, -1) : -1;
    const bandLeftPx   = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, minX, maxX, +1) : -1;
    const bandRightPx  = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, maxX, minX, -1) : -1;
    const underbustLeftPx  = underbustRow > 0 ? findHorizontalInkBound(dark, w, underbustRow, halfRowBand, minX, maxX, +1) : -1;
    const underbustRightPx = underbustRow > 0 ? findHorizontalInkBound(dark, w, underbustRow, halfRowBand, maxX, minX, -1) : -1;
    const cfTopPx      = findVerticalInkBound(dark, w, axisPx, halfColBand, minY, maxY, +1);
    const chestLeftX  = chestLeftPx  > 0 ? chestLeftPx  / w : null;
    const chestRightX = chestRightPx > 0 ? chestRightPx / w : null;
    const bandLeftX   = bandLeftPx   > 0 ? bandLeftPx   / w : null;
    const bandRightX  = bandRightPx  > 0 ? bandRightPx  / w : null;
    const underbustLeftX  = underbustLeftPx  > 0 ? underbustLeftPx  / w : null;
    const underbustRightX = underbustRightPx > 0 ? underbustRightPx / w : null;
    const cfTopY      = cfTopPx      >= 0 ? cfTopPx     / h : null;

    // ---- Cradle-at-CF (POM 6 top endpoint) ----
    // See src/auto/detect/pom6-cradle-cf.js for the full contract, guards and
    // the three acceptance tiers (direct axis ink, CF-gore dip projection,
    // interrupted-placket junction).
    const {
      cradleCfTop,
      cradleCfTopInkRatio,
      cradleCfTopBandInkRatio,
      cradleCfTopSeamHorizontalRun,
      cradleCfTopSeamSingleRowRun,
      cradleCfTopReject,
      cradleCfTopDipProjected,
      cradleCfSeamLeftReachPx,
      cradleCfSeamRightReachPx,
      cradleCfTopJunction,
    } = findCradleCfTop({
      dark, rawDark, w, h,
      minX, minY, maxX, maxY, bboxW, bboxH,
      axisPx, axisXpx,
      rowNoiseFloor, peakSep,
      bandRow, bandEdgeRow,
      chestRow, underbustRow,
      cradleRow, cradleStrength,
      cfTopPx,
    });

    // ---- Cradle-at-bottom-cup (POM 7 endpoints) ----
    // See src/auto/detect/pom7-cradle-cup.js for the full contract, the
    // strong / seam / dashed-guide / arc tiers and their tuned thresholds.
    const {
      cradleCupTop,
      cradleCupBottom,
      cradleCupSide,
      cradleCupTier,
      cradleCupTopInkRatio,
      cradleCupBandInkRatio,
      cradleCupColInkRatio,
      cradleCupSegmentsWithInk,
      cradleCupSegmentCount,
      cradleCupEdgePenalty,
      cradleCupReject,
    } = findCradleCupSeam({
      dark, rawDark, w, h, bounds,
      minX, maxX, bboxW, bboxH,
      axisPx, peakSep,
      rowNoiseFloor,
      bandRow, bandY,
      cradleRow, cradleStrength, cradleY,
      sideLeftCol, sideRightCol, sideLeftX, sideRightX,
      apexLeft, apexRight,
      hemNormAtColumn,
    });

    _stageMark('frontInkEndpoints');

    const sigConf = (peak, floor) => clamp01((peak - floor) / Math.max(1, floor * 2));

    // ---- Stage: cup model for POM 9 / POM 10 ----
    // POM 9 (inner cup height) and POM 10 (inner cup width) belong to ONE cup.
    // Build that cup model from real structure (apex + cradle-cup seam) so
    // both POMs share side/view/center. See buildCupModel above.
    const cradleCupConfidence = cradleCupTop
      ? sigConf(cradleStrength, rowNoiseFloor)
      : 0;
    const cupModel = buildCupModel({
      bounds, w, h, dark,
      axisPx,
      cradleY,
      apexLeft, apexLeftConf: apexLeftInfo ? apexLeftInfo.confidence : 0,
      apexRight, apexRightConf: apexRightInfo ? apexRightInfo.confidence : 0,
      cradleCupTop, cradleCupSide, cradleCupTier, cradleCupConfidence,
      sideLeftX, sideRightX,
      hasFrontInner: viewClassification.frontInnerIndex >= 0,
    });

    _stageMark('cupModel');

    // ---- Stage: back-view features (center axis, panel, strap, side) ----
    // Use the front/back classifier's pick when it produced one. Fall back to
    // "largest non-primary view" only when the classifier is unsure (e.g. one
    // view in the source, or two ambiguous views). These seed back-top /
    // back-bottom for POM 12.
    let backViewIndex = viewClassification.backIndex;
    if (backViewIndex < 0 && viewBoxesPx.length > 1) {
      const candidates = viewBoxesPx
        .map((view, index) => ({ view, index }))
        .filter(item => item.index !== primaryViewIndex)
        .sort((a, b) => (b.view.count || 0) - (a.view.count || 0));
      if (candidates.length) backViewIndex = candidates[0].index;
    }
    const backBox = (backViewIndex >= 0 && viewBoxesPx[backViewIndex]) ? viewBoxesPx[backViewIndex] : null;
    // All back-view landmarks (center axis, panel edges/height, strap top/inner,
    // side seam) come from detectBackLandmarks so the identical pass can re-run
    // if the TD reassigns the back role in the view-role dialog — needed on a
    // 3-panel board where "back" vs "front_inner" was ambiguous and the auto
    // pick was wrong (see maybePromptForViewRoles / redetectBackLandmarks).
    const {
      backInfo, backFeatures, backPanelInfo, backPanelHeightInfo,
      backStrapTopInfo, backStrapInnerInfo, backSideTopInfo, backSideBottomInfo, backSideInfo,
    } = detectBackLandmarks(dark, w, h, backBox);

    _stageMark('backFeatures');

    // ---- Stage: confidence per feature + overall quality ----
    // Layer-1 frame confidences (per rule.md): the symmetry-derived axis is
    // the coordinate prior and the longest-run band row is the baseline prior.
    // Surfaced both at the top level (for downstream POM gating) and inside
    // the layered debug payload so the TD can answer "do we trust the frame?"
    const axisConfidence = clamp01(symmetry);
    const baselineConfidence = sigConf(bandStrength, rowNoiseFloor);
    const confidence = {
      axis: axisConfidence,
      band: baselineConfidence,
      chest: chestY != null ? sigConf(chestStrength, rowNoiseFloor) : 0,
      cradle: cradleY != null ? sigConf(cradleStrength, rowNoiseFloor) : 0,
      cradleCfTop: cradleCfTop
        ? (cradleCfTopDipProjected
            ? Math.min(0.19, sigConf(cradleStrength, rowNoiseFloor))
            : sigConf(cradleStrength, rowNoiseFloor))
        : 0,
      cradleCupTop: cradleCupTop ? sigConf(cradleStrength, rowNoiseFloor) : 0,
      cradleCupBottom: cradleCupBottom ? sigConf(bandStrength, rowNoiseFloor) : 0,
      sideLeft: sideLeftX != null ? sigConf(sideLeftStrength, colNoiseFloor) : 0,
      sideRight: sideRightX != null ? sigConf(sideRightStrength, colNoiseFloor) : 0,
      apexLeft: apexLeftInfo ? apexLeftInfo.confidence : 0,
      apexRight: apexRightInfo ? apexRightInfo.confidence : 0,
      strap: strapInfo ? strapInfo.confidence : 0,
      frontStrapStart: frontStrapStartInfo ? frontStrapStartInfo.confidence : 0,
      back: backInfo ? backInfo.confidence : 0,
      innerCupTop: innerCupTopInfo ? innerCupTopInfo.confidence : 0,
      sideTopLeft: sideTopLeftInfo ? sideTopLeftInfo.confidence : 0,
      sideTopRight: sideTopRightInfo ? sideTopRightInfo.confidence : 0,
      backPanel: backPanelHeightInfo ? backPanelHeightInfo.confidence : (backPanelInfo ? backPanelInfo.confidence : 0),
      backStrapTop: backStrapTopInfo ? backStrapTopInfo.confidence : 0,
    };
    // Overall detection quality: weighted mix of axis symmetry and band/chest
    // strength. Surfaces in the spec-panel header so the TD knows whether to
    // trust the seeds or expect to drag a lot.
    const quality = clamp01(
      0.45 * confidence.axis
      + 0.30 * confidence.band
      + 0.15 * (confidence.chest || 0.25)
      + 0.05 * (confidence.sideLeft || 0)
      + 0.05 * (confidence.sideRight || 0)
    );
    _stageMark('confidence');

    // ---- Stage: assemble detection result ----
    const detectionResult = {
      bbox,
      axisX,
      bandY,
      chestY,
      cradleY,
      sideLeftX,
      sideRightX,
      apexLeft,
      apexRight,
      apexLeftInner,
      apexRightInner,
      apexLeftOuter,
      apexRightOuter,
      apexMissingReason: apexPair ? null : 'No reliable strap-cup joining seam / highest cup point was detected.',
      // Front-view ink endpoints — see "Front-view ink endpoints" pass above.
      chestLeftX,
      chestRightX,
      bandLeftX,
      bandRightX,
      underbustY,
      underbustLeftX,
      underbustRightX,
      underbustRunPx,
      underbustRowPx: underbustRow,
      underbustMinSpanPx: minRowSpan,
      cfTopY,
      cradleCfTop,
      cradleCfTopInkRatio: Number(cradleCfTopInkRatio.toFixed(4)),
      cradleCfTopBandInkRatio: Number(cradleCfTopBandInkRatio.toFixed(4)),
      cradleCfTopSeamHorizontalRun,
      cradleCfTopSeamSingleRowRun,
      cradleCfTopMissingReason: cradleCfTopReject,
      cradleCfTopDipProjected,
      cradleCfTopJunction,
      cradleCupTop,
      cradleCupBottom,
      // Hem row at the CF column, for POM 6's bottom anchor (US-061). Equals
      // bandY on a straight hem; rises above it on an arched / scalloped one.
      cfBottomHemY,
      cradleCupSide,
      cradleCupTier,
      cradleCupTopInkRatio: Number(cradleCupTopInkRatio.toFixed(4)),
      cradleCupBandInkRatio: Number(cradleCupBandInkRatio.toFixed(4)),
      cradleCupColInkRatio: Number(cradleCupColInkRatio.toFixed(4)),
      cradleCupSegmentsWithInk,
      cradleCupSegmentCount,
      cradleCupEdgePenalty: Number(cradleCupEdgePenalty.toFixed(4)),
      cradleCupMissingReason: cradleCupReject,
      strapTop: strapInfo ? strapInfo.top : null,
      strapBottom: strapInfo ? strapInfo.bottom : null,
      frontStrapStart: frontStrapStartInfo ? frontStrapStartInfo.point : null,
      back: backInfo,
      backFeatures,
      // Cup model — shared backbone for POM 9 (height) and POM 10 (width).
      // See buildCupModel for fields. visibility ∈ {direct, inferred, hidden};
      // when 'hidden' the seed layer skips inner-cup-* anchors so POM 9/10
      // demote to REVIEW_ONLY via the requiredAnchors guard.
      cupModel,
      // Audit-driven extra signals (POMs 9, 10, 11, 13).
      innerCupTop: innerCupTopInfo ? innerCupTopInfo.point : null,
      sideTopLeft:  sideTopLeftInfo  ? sideTopLeftInfo.point  : null,
      sideTopRight: sideTopRightInfo ? sideTopRightInfo.point : null,
      sideBottomRight: sideBottomRightInfo ? sideBottomRightInfo.point : null,
      backPanel: backPanelInfo,
      backPanelHeight: backPanelHeightInfo,
      backStrapInner: backStrapInnerInfo,
      backStrapTop: backStrapTopInfo ? backStrapTopInfo.point : null,
      backSideTop: backSideTopInfo ? backSideTopInfo.point : null,
      backSideBottom: backSideBottomInfo ? backSideBottomInfo.point : null,
      backSide: backSideInfo,
      // Junction / endpoint / corner map (Phase 1, plan 2). Normalized
      // coords; consumed by the semantic-snap engine (Phase 4) and the
      // __braDebug.junctions overlay. Empty array when the pass failed.
      // NOTE: detection.junctions is the FULL feature-point list (junctions +
      // endpoints + corners) — the junction-tests / pipeline-tests contract.
      junctions: junctionMap ? junctionMap.points : [],
      junctionSummary: junctionMap ? junctionMap.summary : null,
      // Contour evidence bundle (Engineering Workflow Phase 4). Raw SHAPE
      // evidence kept SEPARATE from the geometry / landmark decisions above:
      // type-split feature points, deterministic stroke stats, and a compact
      // serializable summary. Additive — the junctions / junctionSummary
      // contract above is unchanged. The trace-dependent parts (contours,
      // curveCandidates) are attached later at the Potrace edge.
      endpoints: contourEndpoints,
      corners: contourCorners,
      strokeStats: contourStrokeStats,
      contourEvidence: buildContourEvidenceSummary(contours),
      coverage: globalStats.count / total,
      primaryCoverage: darkCount / total,
      sampleWidth: w,
      sampleHeight: h,
      threshold,
      luminanceThreshold,
      backgroundLum: Math.round(cvAnalysis.backgroundLum || 255),
      detectionParams,
      componentCount: filtered.componentCount,
      keptComponentCount: filtered.keptComponents.length,
      // Normalized segmentation-stage result (Phase 3): one shape across
      // OpenCV / legacy / adapter backends, with a deterministic quality score.
      // Metadata only — the mask itself is exposed separately as inkMask.
      segmentation: serializeSegmentation(segmentation),
      // Top-level mirrors so downstream review logic can read the segmentation
      // verdict without reaching into the block. segmentationReviewRequired is
      // the weak-segmentation review signal (Phase 3, item 3).
      segmentationBackend: segmentation ? segmentation.backend : null,
      segmentationQuality: segmentation ? segmentation.quality : null,
      segmentationWeak: segmentation ? !!segmentation.weak : false,
      segmentationReviewRequired: segmentation ? !!segmentation.reviewRequired : false,
      views: viewBoxesPx.map((box, index) => {
        const role = viewClassification.roles[index] || 'unknown';
        const score = viewClassification.scores[index] || null;
        return {
          ...normalizeBounds(box, w, h),
          role,
          viewRole: role,
          roleConfidence: score && score.roleConfidence != null
            ? Number(score.roleConfidence.toFixed(3))
            : null,
          centroidX: score ? Number(score.centroidX.toFixed(3)) : null,
          widthRatio: score ? Number(score.widthRatio.toFixed(3)) : null,
        };
      }),
      viewBoxes: viewBoxesPx.map((box, index) => {
        const role = viewClassification.roles[index] || 'unknown';
        const legacyRole = role === 'front_outer' ? 'front' : role;
        const score = viewClassification.scores[index] || null;
        return {
          ...normalizeBounds(box, w, h),
          role: legacyRole,
          viewRole: role,
          roleConfidence: score && score.roleConfidence != null
            ? Number(score.roleConfidence.toFixed(3))
            : null,
          centroidX: score ? Number(score.centroidX.toFixed(3)) : null,
          widthRatio: score ? Number(score.widthRatio.toFixed(3)) : null,
        };
      }),
      primaryViewIndex,
      frontViewIndex: viewClassification.frontOuterIndex,
      frontOuterViewIndex: viewClassification.frontOuterIndex,
      frontInnerViewIndex: viewClassification.frontInnerIndex,
      backViewIndex,
      viewRoleReviewRequired: viewClassification.reviewRequired,
      symmetry,
      // Layer-1 frame confidences (rule.md L1). Surfaced top-level so the
      // POM emitter / drafter can read them without diving into the debug
      // payload. axisConfidence is the symmetry-based axis prior;
      // baselineConfidence is the band-row strength above noise.
      axisConfidence,
      baselineConfidence,
      quality,
      confidence,
      engine: (cvAnalysis.engine || 'offline-vision-legacy-threshold') + '+auto-pom-v4-layers',
      // Non-serializable side channel for the Potrace tracer in
      // runOfflineDetection. Stripped before the detection is stored.
      _mask: dark,
      _maskW: w,
      _maskH: h,
    };
    _stageMark('assembleDetection');
    detectionResult.stageTimingsMs = stageTimingsMs;

    // Compact seam-evidence summary at the top level so contract tests (and
    // the spec panel) can read it without enabling cvDebug. Mirrors the
    // detailed payload in detectionResult.debug.layered.seams (which only
    // exists when debugEnabled), but with the minimum fields needed for
    // DRAWABLE / REVIEW_ONLY decisions per rule.md.
    detectionResult.seamEvidence = {
      cradleCfSeam: {
        present: !!cradleCfTop,
        confidence: cradleCfTop ? sigConf(cradleStrength, rowNoiseFloor) : 0,
        missingReason: cradleCfTopReject,
        seamHorizontalRun: cradleCfTopSeamHorizontalRun || 0,
      },
      cradleCupSeam: {
        present: !!cradleCupTop,
        confidence: cradleCupTop ? sigConf(cradleStrength, rowNoiseFloor) : 0,
        side: cradleCupSide || 0,
        tier: cradleCupTier,
        missingReason: cradleCupReject,
      },
      upperCupCfSeam: {
        present: cfTopY != null,
        source: cfTopY != null ? 'cfTopInkBound' : 'viewBoxFallback',
        missingReason: cfTopY != null ? null : 'No CF-column ink found above the band region.',
      },
    };
    // Apex join (POM 16) — confidence + provenance per side. `source` is
    // 'cup-curve' when the strap-cup join seam was the support, 'inferred'
    // when the seed came from a weaker secondary cue, null when no apex
    // anchor was seeded. The detector scans only inside the cup body
    // (below chestRow), so 'strap-ring' is never the source — tests assert
    // this explicitly.
    detectionResult.apexJoin = {
      left: apexLeftInfo
        ? { confidence: apexLeftInfo.confidence, source: 'cup-curve' }
        : { confidence: 0, source: null },
      right: apexRightInfo
        ? { confidence: apexRightInfo.confidence, source: 'cup-curve' }
        : { confidence: 0, source: null },
      pairValidated: !!apexPair,
    };
    // Synthesize a short cupModel id so POM 9 / POM 10 anchors can be
    // asserted to belong to the SAME cup (same side, same view, same
    // top/bottom Y references). Identity-only — never used for geometry.
    if (cupModel) {
      const sidePart = cupModel.side === +1 ? 'R' : (cupModel.side === -1 ? 'L' : 'X');
      const vis = cupModel.visibility ? cupModel.visibility[0] : 'x';
      const topY = cupModel.topPoint ? Math.round(cupModel.topPoint.y * 1000) : 0;
      const botY = cupModel.bottomPoint ? Math.round(cupModel.bottomPoint.y * 1000) : 0;
      cupModel.id = sidePart + ':' + vis + ':' + topY + ':' + botY;
    }

    // ---- Complete the geometry facts with the semantic-part candidates ----
    // (Engineering Workflow Phase 5, items 2-3.) The frame facts (axis, band,
    // rows, side seams, view regions) were built in analyzeGeometry; here we add
    // the cup / strap / seam / back-panel candidate geometry (already computed
    // above as the cup model, apex/strap landmarks, seam evidence, and back-view
    // features) plus an explicit geometry-quality verdict. All values are copies
    // of numbers computed above — nothing is re-detected, so anchors and golden
    // are unchanged. The quality.reviewRequired flag is the geometry stage's own
    // "do we trust the frame?" signal; it is fed into the landmark/anchor review
    // decision (see seedAnchorsFromDetection) so weak geometry raises TD review
    // instead of faking certainty.
    if (geometryFacts) {
      geometryFacts.cupGeometry = cupModel ? {
        id: cupModel.id || null,
        side: cupModel.side,
        viewRole: cupModel.viewRole || null,
        visibility: cupModel.visibility || null,
        topPoint: cupModel.topPoint || null,
        bottomPoint: cupModel.bottomPoint || null,
        innerEdge: cupModel.innerEdge || null,
        outerEdgeNearArmhole: cupModel.outerEdgeNearArmhole || null,
        centerPoint: cupModel.centerPoint || null,
        contourConfidence: cupModel.contourConfidence != null ? cupModel.contourConfidence : null,
        seamConfidence: cupModel.seamConfidence != null ? cupModel.seamConfidence : null,
      } : null;
      geometryFacts.strapGeometry = {
        top: strapInfo ? strapInfo.top : null,
        bottom: strapInfo ? strapInfo.bottom : null,
        confidence: strapInfo ? strapInfo.confidence : 0,
        frontStart: frontStrapStartInfo ? frontStrapStartInfo.point : null,
        frontStartConfidence: frontStrapStartInfo ? frontStrapStartInfo.confidence : 0,
        apexLeft: apexLeft || null,
        apexRight: apexRight || null,
        apexPairValidated: !!apexPair,
      };
      geometryFacts.seamGeometry = {
        cradleCfTop: cradleCfTop || null,
        cradleCfDipProjected: !!cradleCfTopDipProjected,
        cradleCfJunction: !!cradleCfTopJunction,
        cradleCupTop: cradleCupTop || null,
        cradleCupBottom: cradleCupBottom || null,
        cradleCupSide: cradleCupSide || 0,
        cradleCupTier,
        upperCupCfSeamPresent: cfTopY != null,
      };
      geometryFacts.backPanelGeometry = {
        present: backViewIndex >= 0,
        viewIndex: backViewIndex,
        panelTop: backPanelInfo && backPanelInfo.top ? backPanelInfo.top : null,
        panelBottom: backPanelInfo && backPanelInfo.bottom ? backPanelInfo.bottom : null,
        panelHeightConfidence: backPanelHeightInfo
          ? backPanelHeightInfo.confidence
          : (backPanelInfo ? backPanelInfo.confidence : 0),
        strapTop: backStrapTopInfo ? backStrapTopInfo.point : null,
        sideTop: backSideTopInfo ? backSideTopInfo.point : null,
        sideBottom: backSideBottomInfo ? backSideBottomInfo.point : null,
      };
      // Geometry-quality verdict. Deterministic mix of the axis/band frame
      // priors and the view-classification confidence. reviewRequired fires only
      // when the geometry is genuinely weak (ambiguous view roles, or a frame
      // prior near the floor) — on a cleanly detected sketch every term is
      // strong, so the flag is false and no well-detected landmark is disturbed.
      const geomAxisConf = clamp01(symmetry);
      const geomBandConf = baselineConfidence;
      const roleRegions = (geometryFacts.viewRegions || [])
        .filter(r => r.role && r.role !== 'unknown' && r.roleConfidence != null);
      const viewConfidence = roleRegions.length
        ? clamp01(roleRegions.reduce((s, r) => s + r.roleConfidence, 0) / roleRegions.length)
        : (geometryFacts.viewRegions && geometryFacts.viewRegions.length ? 0.35 : 0);
      const geometryOverall = clamp01(
        0.45 * geomAxisConf + 0.30 * geomBandConf + 0.25 * viewConfidence
      );
      const geometryReasons = [];
      if (viewClassification.reviewRequired) geometryReasons.push('view roles are ambiguous — confirm which region is front/back/inner');
      if (geomAxisConf < 0.15) geometryReasons.push('weak symmetry axis — the center-front prior is unreliable');
      if (geomBandConf < 0.15) geometryReasons.push('weak band line — the baseline prior is unreliable');
      const geometryReviewRequired = !!viewClassification.reviewRequired
        || geomAxisConf < 0.15
        || geomBandConf < 0.15;
      geometryFacts.quality = {
        axisConfidence: Number(geomAxisConf.toFixed(4)),
        baselineConfidence: Number(geomBandConf.toFixed(4)),
        viewConfidence: Number(viewConfidence.toFixed(4)),
        overall: Number(geometryOverall.toFixed(4)),
        reviewRequired: geometryReviewRequired,
        reasons: geometryReasons,
      };
      detectionResult.geometryFacts = geometryFacts;
      detectionResult.geometryReviewRequired = geometryReviewRequired;
    }

    // ---- Landmark QA layer (Engineering Workflow Phase 6) ----
    // Classify every anchor-schema kind — source class (detected / derived /
    // projected / missing), confidence tier, review verdict, and QA notes —
    // BEFORE anchor placement. Read-only over the assembled result; the seed
    // layer recomputes it at seed time (the detection object can be mutated
    // between runs) and consumes the same verdicts, so this attach is the
    // stage-level record, not a second decision path.
    detectionResult.landmarkQa = buildLandmarkQaFromDetection(detectionResult);
    _stageMark('landmarkQa');

    // CV Debug snapshot — intermediate detector state in pixel coords, captured
    // only when the caller asked for it. See src/auto/detect/cv-debug-payload.js
    // for the payload's contents and its layered POM 6/7/8 view.
    if (debugEnabled) {
      detectionResult.debug = buildCvDebugPayload({
        apexLeftCandidate, apexPair, apexRightCandidate,
        axisConfidence, axisGuard, axisPx, axisX, axisXpx,
        backFeatures, backViewIndex,
        bandEdgeRow, bandPreferred, bandRow, bandStart, bandStrength,
        baselineConfidence,
        cfTopY, chestRow, chestStrength, chestY, colNoiseFloor,
        cradleCfSeamLeftReachPx, cradleCfSeamRightReachPx,
        cradleCfTop, cradleCfTopBandInkRatio, cradleCfTopDipProjected,
        cradleCfTopInkRatio, cradleCfTopJunction, cradleCfTopReject,
        cradleCfTopSeamHorizontalRun, cradleCfTopSeamSingleRowRun,
        cradleCupBandInkRatio, cradleCupBottom, cradleCupColInkRatio,
        cradleCupEdgePenalty, cradleCupReject, cradleCupSegmentCount,
        cradleCupSegmentsWithInk, cradleCupSide, cradleCupTier,
        cradleCupTop, cradleCupTopInkRatio,
        cradleRow, cradleStrength, cradleY,
        cupModel, cvAnalysis, darkCount, detectionParams, detectionResult,
        filtered, h, inkCleanupReverted, innerHi, innerLo, luminanceThreshold,
        maxX, maxY, medianCol, medianRow, minRowSpan, minX, minY,
        peakSep, primaryViewIndex, rawStats, rowNoiseFloor, segmentation,
        sideLeftCol, sideLeftStrength, sideLeftX,
        sideRightCol, sideRightStrength, sideRightX,
        sigConf, stageTimingsMs, symmetry, threshold,
        underbustRow, underbustRunPx, underbustStrength,
        viewBoxesPx, viewClassification, w,
      });
    }
    return detectionResult;
  }
