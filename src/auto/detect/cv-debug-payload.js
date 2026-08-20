// CV-debug payload — the layered ?cvDebug=1 diagnostics snapshot
// (buildCvDebugPayload). Pure serialization: safeNum-rounded mirrors of values
// the detector already decided, plus the L1/L2/L3 frame / regions / seams
// layer view of the POM 6 / 7 / 8 decision pipeline. It has ZERO effect on the
// detection result — nothing downstream reads it back.
//
// Its caller is src/auto/detect/landmark-stage.js, which keeps the debugEnabled
// guard and attaches the result as detectionResult.debug.
// Source part for app.js. Run `npm run build` after editing.

  // Build the opt-in CV-debug payload. `ctx` carries every local the snapshot
  // mirrors; the payload is read-only over them and decides nothing itself.
  function buildCvDebugPayload(ctx) {
    const {
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
    } = ctx;

    // CV Debug snapshot — intermediate detector state in pixel coords.
    // Mirrors the locals used to pick anchors so the TD can answer "why did
    // the detector choose this row/column?" without sprinkling console.logs.
    // Capture summary fields only — masks and per-row arrays are large; the
    // mask itself is encoded later (DOM edge) when debug.includeMask is set.
    const safeNum = (v, digits) => {
      if (!Number.isFinite(v)) return null;
      const f = Math.pow(10, digits || 4);
      return Math.round(v * f) / f;
    };
    const keptComponents = filtered.keptComponents || [];
    return {
      version: 1,
      engine: detectionResult.engine,
      sampleWidth: w,
      sampleHeight: h,
      thresholds: {
        ink: threshold,
        luminance: luminanceThreshold,
        backgroundLum: Math.round(cvAnalysis.backgroundLum || 255),
      },
      detectionParams: { ...detectionParams },
      rawInk: {
        count: rawStats.count,
        minX: rawStats.minX, minY: rawStats.minY,
        maxX: rawStats.maxX, maxY: rawStats.maxY,
      },
      components: {
        componentCount: filtered.componentCount || 0,
        keptComponentCount: keptComponents.length,
        // Cap to keep the payload bounded — pathological sketches can yield
        // hundreds of stray components; the top ones by ink count are what
        // a debugger actually wants to see.
        kept: keptComponents
          .slice()
          .sort((a, b) => (b.count || 0) - (a.count || 0))
          .slice(0, 64)
          .map(c => ({
            minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
            count: c.count,
            cx: Math.round(c.cx || 0), cy: Math.round(c.cy || 0),
            density: safeNum(c.density, 4),
          })),
      },
      viewBoxes: viewBoxesPx.map((box, i) => ({
        minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY,
        count: box.count || 0,
        role: (viewClassification.roles && viewClassification.roles[i]) || 'unknown',
        roleConfidence: viewClassification.scores && viewClassification.scores[i]
          ? safeNum(viewClassification.scores[i].roleConfidence, 3)
          : null,
      })),
      primaryViewIndex,
      frontOuterViewIndex: viewClassification.frontOuterIndex,
      frontInnerViewIndex: viewClassification.frontInnerIndex,
      backViewIndex,
      primary: {
        minX, minY, maxX, maxY,
        count: darkCount,
        axisPx: Math.round(axisXpx),
        symmetry: safeNum(symmetry, 4),
      },
      rows: {
        noiseFloor: safeNum(rowNoiseFloor, 2),
        medianRow,
        bandRow,
        bandEdgeRow,
        bandStrength: safeNum(bandStrength, 2),
        bandSearchStartPx: bandStart,
        bandPreferredPx: Math.round(bandPreferred),
        chestRow,
        chestStrength: safeNum(chestStrength, 2),
        chestY: chestY != null ? safeNum(chestY, 4) : null,
        cradleRow,
        cradleStrength: safeNum(cradleStrength, 2),
        cradleY: cradleY != null ? safeNum(cradleY, 4) : null,
        cradleCfTop: cradleCfTop
          ? { x: safeNum(cradleCfTop.x, 4), y: safeNum(cradleCfTop.y, 4) }
          : null,
        cradleCfTopInkRatio: safeNum(cradleCfTopInkRatio, 4),
        cradleCfTopBandInkRatio: safeNum(cradleCfTopBandInkRatio, 4),
        cradleCfTopSeamHorizontalRun,
        cradleCfTopSeamSingleRowRun,
        cradleCfTopMissingReason: cradleCfTopReject,
        cradleCfTopDipProjected,
        cradleCfTopJunction,
        cradleCfSeamLeftReachPx,
        cradleCfSeamRightReachPx,
        cradleCupTop: cradleCupTop
          ? { x: safeNum(cradleCupTop.x, 4), y: safeNum(cradleCupTop.y, 4) }
          : null,
        cradleCupBottom: cradleCupBottom
          ? { x: safeNum(cradleCupBottom.x, 4), y: safeNum(cradleCupBottom.y, 4) }
          : null,
        cradleCupSide,
        cradleCupTier,
        cradleCupTopInkRatio: safeNum(cradleCupTopInkRatio, 4),
        cradleCupBandInkRatio: safeNum(cradleCupBandInkRatio, 4),
        cradleCupColInkRatio: safeNum(cradleCupColInkRatio, 4),
        cradleCupSegmentsWithInk,
        cradleCupSegmentCount,
        cradleCupEdgePenalty: safeNum(cradleCupEdgePenalty, 4),
        cradleCupMissingReason: cradleCupReject,
        underbustRow,
        underbustStrength: safeNum(underbustStrength, 2),
        underbustRunPx,
        minRowSpanPx: minRowSpan,
      },
      apex: {
        leftCandidate: apexLeftCandidate ? {
          x: safeNum(apexLeftCandidate.point.x, 4),
          y: safeNum(apexLeftCandidate.point.y, 4),
          confidence: safeNum(apexLeftCandidate.confidence, 3),
          support: apexLeftCandidate.support || null,
        } : null,
        rightCandidate: apexRightCandidate ? {
          x: safeNum(apexRightCandidate.point.x, 4),
          y: safeNum(apexRightCandidate.point.y, 4),
          confidence: safeNum(apexRightCandidate.confidence, 3),
          support: apexRightCandidate.support || null,
        } : null,
        accepted: !!apexPair,
        missingReason: apexPair ? null : 'No reliable strap-cup joining seam / highest cup point was detected.',
      },
      cupModel: cupModel ? {
        side: cupModel.side,
        viewRole: cupModel.viewRole,
        visibility: cupModel.visibility,
        topFromApex: cupModel.topFromApex,
        bottomFromSeam: cupModel.bottomFromSeam,
        topPoint: cupModel.topPoint
          ? { x: safeNum(cupModel.topPoint.x, 4), y: safeNum(cupModel.topPoint.y, 4) }
          : null,
        bottomPoint: cupModel.bottomPoint
          ? { x: safeNum(cupModel.bottomPoint.x, 4), y: safeNum(cupModel.bottomPoint.y, 4) }
          : null,
        innerEdge: cupModel.innerEdge
          ? { x: safeNum(cupModel.innerEdge.x, 4), y: safeNum(cupModel.innerEdge.y, 4) }
          : null,
        outerEdgeNearArmhole: cupModel.outerEdgeNearArmhole
          ? { x: safeNum(cupModel.outerEdgeNearArmhole.x, 4), y: safeNum(cupModel.outerEdgeNearArmhole.y, 4) }
          : null,
        centerPoint: cupModel.centerPoint
          ? { x: safeNum(cupModel.centerPoint.x, 4), y: safeNum(cupModel.centerPoint.y, 4) }
          : null,
        apexAnchor: cupModel.apexAnchor
          ? { x: safeNum(cupModel.apexAnchor.x, 4), y: safeNum(cupModel.apexAnchor.y, 4) }
          : null,
        seamAnchor: cupModel.seamAnchor
          ? { x: safeNum(cupModel.seamAnchor.x, 4), y: safeNum(cupModel.seamAnchor.y, 4) }
          : null,
        contourConfidence: safeNum(cupModel.contourConfidence, 3),
        seamConfidence: safeNum(cupModel.seamConfidence, 3),
        texturePenalty: safeNum(cupModel.texturePenalty, 3),
        sideReason: cupModel.sideReason,
        visibilityReason: cupModel.visibilityReason,
        rejectedTextureReason: cupModel.rejectedTextureReason,
        reason: cupModel.reason,
        diagnostics: cupModel.diagnostics
          ? {
              hasFrontInner: !!cupModel.diagnostics.hasFrontInner,
              apexLeftPresent: !!cupModel.diagnostics.apexLeftPresent,
              apexRightPresent: !!cupModel.diagnostics.apexRightPresent,
              apexLeftConf: safeNum(cupModel.diagnostics.apexLeftConf, 3),
              apexRightConf: safeNum(cupModel.diagnostics.apexRightConf, 3),
              sidePicked: cupModel.diagnostics.sidePicked,
              apexPointPresent: !!cupModel.diagnostics.apexPointPresent,
              apexConfPicked: safeNum(cupModel.diagnostics.apexConfPicked, 3),
              cradleCupTopPresent: !!cupModel.diagnostics.cradleCupTopPresent,
              cradleCupSide: cupModel.diagnostics.cradleCupSide,
              cradleCupSideMatches: !!cupModel.diagnostics.cradleCupSideMatches,
              cradleYPresent: !!cupModel.diagnostics.cradleYPresent,
              cradleCupConfidence: safeNum(cupModel.diagnostics.cradleCupConfidence, 3),
              apexY: safeNum(cupModel.diagnostics.apexY, 4),
              seamY: safeNum(cupModel.diagnostics.seamY, 4),
              topFromApex: !!cupModel.diagnostics.topFromApex,
              bottomFromSeam: !!cupModel.diagnostics.bottomFromSeam,
              visibility: cupModel.diagnostics.visibility,
              visibilityReason: cupModel.diagnostics.visibilityReason,
              innerEdgeSource: cupModel.diagnostics.innerEdgeSource || null,
              innerEdgeX: safeNum(cupModel.diagnostics.innerEdgeX, 4),
              outerEdgeX: safeNum(cupModel.diagnostics.outerEdgeX, 4),
              innerEdgeSupported: cupModel.diagnostics.innerEdgeSupported !== false,
            }
          : null,
      } : null,
      cols: {
        noiseFloor: safeNum(colNoiseFloor, 2),
        medianCol,
        sideLeftCol,
        sideLeftStrength: safeNum(sideLeftStrength, 2),
        sideRightCol,
        sideRightStrength: safeNum(sideRightStrength, 2),
        axisGuardPx: axisGuard,
        innerScanLoPx: innerLo,
        innerScanHiPx: innerHi,
      },
      backFeatures: backFeatures ? {
        axisX: backFeatures.axisX,
        chestY: backFeatures.chestY,
        bandY: backFeatures.bandY,
        sideLeftX: backFeatures.sideLeftX,
        sideRightX: backFeatures.sideRightX,
      } : null,
      confidence: { ...detectionResult.confidence },
      quality: safeNum(detectionResult.quality, 4),
      // Normalized segmentation-stage verdict (Phase 3): backend, coverage,
      // deterministic quality, and the weak-segmentation review signal.
      segmentation: detectionResult.segmentation,
      stageTimingsMs,
      // Layer-by-layer view of the POM 6 / 7 / 8 decision pipeline per
      // rule.md. Each layer summarises the evidence that feeds into the
      // next so the TD can answer "why is this POM REVIEW_ONLY?" without
      // reading the detection source.
      //
      // L1 frame:    coordinate-prior confidences (axis from symmetry,
      //              baseline from band-row strength).
      // L2 regions:  semantic search zones in pixel coords (CF / cup-side
      //              / band / above-cradle).
      // L3 seams:    per-seam evidence and decision. confidence in [0,1].
      //              missingReason is null on accept, populated on reject.
      // L4/L5/L6:    POM emission + cross-POM validation lives in the
      //              drafter (auto-drafts.js POM_TEMPLATE.requiredAnchors).
      //              The detector exposes the inputs; the drafter applies
      //              the missing-anchor guard that drives REVIEW_ONLY.
      layers: {
        frame: {
          axisXpx: Math.round(axisXpx),
          bandRowPx: bandRow,
          axisConfidence: safeNum(axisConfidence, 4),
          baselineConfidence: safeNum(baselineConfidence, 4),
          // Per rule.md L1, low axis/baseline confidence should bias POM
          // 6 / 7 / 8 toward REVIEW_ONLY even if downstream signals look
          // OK. Surface a single flag so the drafter / spec-panel can
          // present a coherent reason.
          frameWarning: inkCleanupReverted
            ? 'Ink cleanup was reverted (very faint/dashed sketch or a heavy scan frame) — the outline may include page edges or speckle; verify the detected shape and all POMs.'
            : ((axisConfidence < 0.4 || baselineConfidence < 0.4)
              ? 'Low axis or baseline confidence — treat POM 6/7/8 with caution.'
              : ((segmentation && segmentation.weak)
                ? 'Weak segmentation (low mask quality) — the detected ink may be noisy or incomplete; verify all POMs.'
                : null)),
          // D7: raw boolean so the spec-panel / drafter can react
          // specifically to a fail-open ink-cleanup revert if desired.
          inkCleanupReverted: inkCleanupReverted,
        },
        regions: {
          // CF zone: narrow band around the symmetry axis. POM 6 / POM 8
          // candidates must live inside this zone.
          cfZonePx: {
            xLo: Math.max(0, axisPx - Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18))),
            xHi: Math.min(w - 1, axisPx + Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18))),
          },
          // Bottom-cup zone: between the CF axis buffer and the side seam
          // buffer. POM 7 candidates must live inside this zone.
          bottomCupZonePx: {
            left:  { xLo: sideLeftCol > 0 ? sideLeftCol + Math.max(2, Math.round((maxX - minX) * 0.03)) : null,
                     xHi: axisPx - Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18)) },
            right: { xLo: axisPx + Math.max(peakSep * 2, Math.round((maxX - minX) * 0.18)),
                     xHi: sideRightCol > 0 ? sideRightCol - Math.max(2, Math.round((maxX - minX) * 0.03)) : null },
          },
          bandRowPx: bandRow,
          cradleRowPx: cradleRow,
        },
        seams: {
          // Cradle/cup-bottom seam at center front — POM 6 start endpoint.
          // Accepted only with real ink near the cradle row × axis cell.
          cradleCfSeam: {
            accepted: !!cradleCfTop,
            point: cradleCfTop
              ? { x: safeNum(cradleCfTop.x, 4), y: safeNum(cradleCfTop.y, 4) }
              : null,
            inkRatio: safeNum(cradleCfTopInkRatio, 4),
            bandInkRatio: safeNum(cradleCfTopBandInkRatio, 4),
            seamHorizontalRun: cradleCfTopSeamHorizontalRun,
            seamSingleRowRun: cradleCfTopSeamSingleRowRun,
            confidence: cradleCfTop ? safeNum(sigConf(cradleStrength, rowNoiseFloor), 4) : 0,
            missingReason: cradleCfTopReject,
          },
          // Cradle/cup-bottom seam at the bottom-cup position — POM 7
          // start endpoint. Accepted only when cradle ink + band ink +
          // vertical column ink (continuous OR dashed via segments)
          // co-occur at a column off the CF axis and off the side seam.
          cradleBottomCupSeam: {
            accepted: !!cradleCupTop,
            point: cradleCupTop
              ? { x: safeNum(cradleCupTop.x, 4), y: safeNum(cradleCupTop.y, 4) }
              : null,
            side: cradleCupSide,
            cradleInkRatio: safeNum(cradleCupTopInkRatio, 4),
            bandInkRatio: safeNum(cradleCupBandInkRatio, 4),
            colInkRatio: safeNum(cradleCupColInkRatio, 4),
            segmentsWithInk: cradleCupSegmentsWithInk,
            segmentCount: cradleCupSegmentCount,
            edgePenalty: safeNum(cradleCupEdgePenalty, 4),
            confidence: cradleCupTop ? safeNum(sigConf(cradleStrength, rowNoiseFloor), 4) : 0,
            missingReason: cradleCupReject,
          },
          // Upper-cup seam at center front — POM 8 start endpoint. For now
          // sourced from cfTopY (topmost CF-column ink); the drafter
          // currently consumes the cf-top anchor, which falls back to
          // view-box ratio when cfTopY is null. The frame warning above
          // tracks whether that fallback is happening.
          upperCupCfSeam: {
            accepted: cfTopY != null,
            point: cfTopY != null ? { x: safeNum(axisX, 4), y: safeNum(cfTopY, 4) } : null,
            source: cfTopY != null ? 'cfTopInkBound' : 'viewBoxFallback',
            missingReason: cfTopY != null ? null : 'No CF-column ink found above the band region.',
          },
          // Side seam (POM 11). Listed so cross-POM validation can compare
          // POM 7 candidates against the side seam x.
          sideSeam: {
            left:  sideLeftX  != null ? { x: safeNum(sideLeftX, 4) }  : null,
            right: sideRightX != null ? { x: safeNum(sideRightX, 4) } : null,
          },
        },
        // Cross-POM rule status (rule.md L5). These rules are enforced
        // either by construction (POM 8 end == POM 6 start because both
        // read cradle-cf-top) or by the detector's search-window buffers
        // (POM 7 ≥ 18% bbox width off CF, ≥ 3% off side seam). Surface
        // the status so the TD can confirm.
        crossPom: {
          pom8EndEqualsPom6Start: !!cradleCfTop,
          pom7DistinctFromPom6:
            !!(cradleCupTop && cradleCfTop)
              ? Math.abs(cradleCupTop.x - cradleCfTop.x) > 0.05
              : null,
          pom7OffSideSeam: !!cradleCupTop
            ? (cradleCupSide < 0
                ? (sideLeftX  == null || Math.abs(cradleCupTop.x - sideLeftX)  > 0.03)
                : (sideRightX == null || Math.abs(cradleCupTop.x - sideRightX) > 0.03))
            : null,
        },
      },
    };
  }
