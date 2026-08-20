// Stage 4 of the detection pipeline: geometry analysis. Groups the ink into view
// boxes and dispatches their roles, refines the symmetry axis, picks the band /
// chest / cradle / underbust row peaks and the side-seam columns, and assembles
// the explicit geometryFacts block — all in pixel space, before any anchor
// exists. Also holds buildGeometryViewRegions, the view-region fact builder it
// feeds.
//
// The object analyzeGeometry returns is the contract the landmark stage
// destructures, so its shape must not drift.
//
// Depends on view-boxes.js, segmentation.js and math-utils.js.
// Source part for app.js. Run `npm run build` after editing.

  // Phase 5: build the explicit VIEW-REGION facts. View classification is a
  // GEOMETRY decision (role + confidence per detected garment component) that is
  // produced here, in the geometry stage, BEFORE any anchor is placed — the seed
  // layer only READS these roles, it never re-derives them. Surfacing the
  // regions as a first-class list (with role, confidence, primary flag, and both
  // pixel + normalized bbox) makes that separation visible instead of implicit.
  // Pure restructuring of values classifySketchViewRoles already computed — no
  // numeric change to any role or bbox.
  function buildGeometryViewRegions(viewBoxesPx, viewClassification, primaryViewIndex, w, h) {
    const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1e3) / 1e3 : null);
    return (viewBoxesPx || []).map((box, index) => {
      const role = (viewClassification.roles && viewClassification.roles[index]) || 'unknown';
      const score = (viewClassification.scores && viewClassification.scores[index]) || null;
      const norm = normalizeBounds(box, w, h);
      return {
        index,
        role,
        viewRole: role,
        isPrimary: index === primaryViewIndex,
        roleConfidence: score && score.roleConfidence != null ? round3(score.roleConfidence) : null,
        centroidX: score ? round3(score.centroidX) : null,
        widthRatio: score ? round3(score.widthRatio) : null,
        bboxPx: { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY, count: box.count || 0 },
        bboxNorm: { x: norm.x, y: norm.y, width: norm.width, height: norm.height },
      };
    });
  }

  // ---- Stage 4: geometry analysis ----
  // Input: the segmentation stage output (cleaned + raw masks, stats,
  // components). Output: geometry facts in pixel space — view boxes and their
  // roles, the symmetry axis, band/chest/cradle/underbust rows, and the
  // side-seam columns. Still not the final POM decision. Returns
  // { earlyReturn } when the primary view has too little ink.
  function analyzeGeometry(seg, ctx) {
    const { detectionParams, stageTimingsMs } = ctx;
    const _stageMark = ctx.mark;
    // Phase 4: the contour-evidence bundle (endpoints / curve candidates /
    // stroke stats) is available here via ctx.contourEvidence so geometry can
    // read shape evidence without re-deriving it. Geometry decisions do not
    // consume it yet — wiring that in is Phase 5 — so output stays identical.
    const contourEvidence = ctx.contourEvidence || null;
    void contourEvidence;
    const {
      dark, rawDark, w, h, total, globalStats, filtered,
      threshold, luminanceThreshold,
    } = seg;

    // ---- Stage: view-box grouping + role classification ----
    let viewBoxesPx = detectSketchViewBoxes(filtered.keptComponents, globalStats, w, h);
    if (ctx.singleView) {
      // Auxiliary single-view photo (e.g. a front-inner cutaway): force ONE
      // view spanning ALL ink and skip the panel split. The split + front/back/
      // inner classifier is for multi-panel boards; on a lone cutaway the gore
      // gap and cup shading read as vertical alleys and carve it into 3 boxes,
      // so the "front" primary collapses onto a single cup and axis/apex/side
      // land in the wrong tenth of the image. One whole-garment box keeps the
      // symmetry axis centered and the cup/neckline/armhole landmarks correct.
      viewBoxesPx = [statsToBounds(globalStats)];
    } else {
      // Component grouping keys off horizontal gaps, so unevenly-spaced panels
      // can merge (a 3-panel board where two panels sit closer than the gap
      // threshold collapses into one double-wide box). Split any over-wide box
      // at its empty vertical alley so each garment panel gets its own view
      // box; the single lone-box case (two views bridged by stray ink) is
      // subsumed here.
      viewBoxesPx = splitWideViewBoxes(viewBoxesPx, dark, w, h);
    }
    // Flexible view-role classification. Supports a two-view layout
    // (front_outer + back) and a three-view layout (front_outer + back +
    // front_inner). Role metadata, rather than image position, drives later
    // POM placement.
    const viewClassification = classifySketchViewRoles(dark, w, h, viewBoxesPx);
    const symPrimaryIndex = choosePrimaryViewBox(viewBoxesPx, dark, w, h);
    const primaryViewIndex = viewClassification.frontOuterIndex >= 0
      ? viewClassification.frontOuterIndex
      : symPrimaryIndex;
    const primaryBounds = viewBoxesPx[primaryViewIndex] || statsToBounds(globalStats);
    let localStats = buildMaskStats(dark, w, h, primaryBounds);
    if (localStats.count < 80) localStats = globalStats;

    const colDark = localStats.colDark;
    const rowDark = localStats.rowDark;
    const darkCount = localStats.count;
    let minX = localStats.minX;
    let minY = localStats.minY;
    let maxX = localStats.maxX;
    let maxY = localStats.maxY;

    if (maxX < 0 || maxY < 0 || darkCount < 80) {
      return {
        earlyReturn: {
          coverage: globalStats.count / total, threshold, luminanceThreshold, stageTimingsMs,
          segmentation: seg.segmentation ? serializeSegmentation(seg.segmentation) : null,
        },
      };
    }
    _stageMark('viewBoxes');

    // Bounding box: pad by 1 pixel and clip.
    const padMinX = Math.max(0, minX - 1);
    const padMinY = Math.max(0, minY - 1);
    const padMaxX = Math.min(w - 1, maxX + 1);
    const padMaxY = Math.min(h - 1, maxY + 1);
    const bbox = {
      x: padMinX / w,
      y: padMinY / h,
      width: (padMaxX - padMinX + 1) / w,
      height: (padMaxY - padMinY + 1) / h,
    };
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;

    // ---- Stage: center axis (centroid candidate → symmetry-refined) ----
    let xSum = 0, xWeight = 0;
    for (let x = minX; x <= maxX; x += 1) {
      xSum += x * colDark[x];
      xWeight += colDark[x];
    }
    const centroidX = xWeight > 0 ? xSum / xWeight : (minX + maxX) / 2;
    const axisXpx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);
    const axisX = axisXpx / w;
    const symmetry = computeSymmetryScore(dark, w, axisXpx, minX, maxX, minY, maxY);

    _stageMark('centerAxis');

    // ---- Stage: horizontal features (band, chest, cradle, underbust) ----
    const rowSmooth = smooth1D(rowDark);
    const rowSpan = computeRowSpans(dark, w, minX, maxX, minY, maxY);
    const rowRun = computeRowMaxRun(dark, w, minX, maxX, minY, maxY);
    const medianRow = approxMedianNonZero(rowDark, minY, maxY);
    const rowNoiseFloor = Math.max(5, medianRow) * detectionParams.rowNoiseMultiplier;
    const rowPeakScore = (y, preferredY, spread) => {
      const spanNorm = clamp01(rowSpan[y] / Math.max(1, bboxW));
      const base = rowSmooth[y] * (0.58 + spanNorm * 0.42);
      if (preferredY == null) return base;
      const pos = 1 - Math.min(1, Math.abs(y - preferredY) / Math.max(1, spread));
      return base * (0.82 + pos * 0.18);
    };

    // Band: long horizontal ink near the bottom, not just the single darkest row.
    const bandStart = Math.round(minY + bboxH * detectionParams.bandSearchStartRatio);
    let bandRow = -1;
    let bandStrength = 0;
    const bandPreferred = minY + bboxH * detectionParams.bandPreferredRatio;
    for (let y = bandStart; y <= maxY; y += 1) {
      const score = rowPeakScore(y, bandPreferred, bboxH * 0.22);
      if (score > bandStrength) {
        bandStrength = score;
        bandRow = y;
      }
    }
    // bandRow is the band ZONE (used below to bound cup/cradle searches).
    // bandEdgeRow snaps to the solid bottom edge for the band ANCHORS only, so
    // the bottom-band and CF-bottom land on the real edge without disturbing the
    // cup detection that keys off the zone.
    const bandEdgeRow = snapBandToSolidEdge(rowRun, bandRow, minY, maxY, bboxW, bboxH);
    const bandY = bandEdgeRow >= 0 ? bandEdgeRow / h : (minY + maxY) / 2 / h;

    // Chest: long row in the upper cup/underarm zone. Skip the top few rows
    // so straps or page crop marks don't win.
    const chestStart = Math.round(minY + bboxH * 0.08);
    const chestEnd = Math.round(minY + bboxH * 0.50);
    let chestRow = -1;
    let chestStrength = 0;
    const chestPreferred = minY + bboxH * 0.30;
    for (let y = chestStart; y <= chestEnd; y += 1) {
      const score = rowPeakScore(y, chestPreferred, bboxH * 0.26);
      if (score > chestStrength) {
        chestStrength = score;
        chestRow = y;
      }
    }
    const chestY = (chestRow >= 0 && chestStrength > rowNoiseFloor * 1.5)
      ? chestRow / h : null;

    // Cradle / cup-bottom — peak between chest and band, separated from each
    // by at least 5% of bbox height. Used to seed inner-cup-bottom.
    const peakSep = Math.max(4, Math.round(bboxH * 0.05));
    const cradleLo = (chestRow > 0 ? chestRow : minY + Math.round(bboxH * 0.40)) + peakSep;
    const cradleHi = bandRow - peakSep;
    let cradleRow = -1;
    let cradleStrength = 0;
    for (let y = cradleLo; y <= cradleHi; y += 1) {
      const score = rowPeakScore(y, minY + bboxH * 0.64, bboxH * 0.24);
      if (score > cradleStrength) {
        cradleStrength = score;
        cradleRow = y;
      }
    }
    const cradleY = (cradleRow >= 0 && cradleStrength > rowNoiseFloor * 1.3)
      ? cradleRow / h : null;

    // Chest line (POM 3): the horizontal row in the cup zone where the
    // sketch's outline is widest. In a flat technical sketch this row is
    // (a) the cup-bottom seam (a solid line), OR (b) the bust-point row where
    // the cup outline is at its widest horizontal extent — both register as
    // "row with max left-to-right ink span". We search BETWEEN the upper
    // chest peak and the band, so the band itself isn't a candidate. The
    // preference pulls us toward ~62% bbox height where the cup widens.
    const underbustLo = (chestRow > 0 ? chestRow : Math.round(minY + bboxH * 0.30)) + peakSep;
    const underbustHi = (bandRow > 0 ? bandRow : maxY) - peakSep;
    let underbustRow = -1;
    let underbustStrength = 0;
    const underbustPreferred = minY + bboxH * 0.62;
    const underbustSpread = Math.max(1, bboxH * 0.28);
    const minRowSpan = Math.max(20, Math.round(bboxW * 0.70));
    for (let y = underbustLo; y <= underbustHi; y += 1) {
      const span = rowSpan[y];
      if (span < minRowSpan) continue;
      // Solidity: a real underbust seam is ONE long contiguous run, while a
      // lace band is a wide row made of many short dashes. runFrac rewards
      // solid rows so the seam beats a wider-but-fragmented lace band.
      const runFrac = clamp01(rowRun[y] / Math.max(1, span));
      const pos = 1 - Math.min(1, Math.abs(y - underbustPreferred) / underbustSpread);
      const score = span * (0.55 + 0.45 * runFrac) * (0.7 + pos * 0.3);
      if (score > underbustStrength) {
        underbustStrength = score;
        underbustRow = y;
      }
    }
    const underbustRunPx = underbustRow >= 0 ? rowRun[underbustRow] : 0;
    const underbustY = underbustRow >= 0 ? underbustRow / h : null;

    _stageMark('horizontalFeatures');

    // ---- Stage: vertical features (side seams) ----
    // Scan the FULL bbox height (minY → bandRow), not just chestRow → bandRow.
    // On longline / high-cut / plunge styles the side seam extends well above
    // the chest line; clipping the scan at chestRow throws away the bulk of
    // that ink and the real edge column never beats the noise floor.
    const seamTop = minY;
    const seamBottom = bandRow > 0 ? bandRow : maxY;
    const colTorso = countDarkByColumnInRange(dark, w, minX, maxX, seamTop, seamBottom);
    const colSmooth = smooth1D(colTorso);
    // Noise floor from the inner 20–80% of columns only. On 3-part cups or
    // styles with heavy internal construction (cup seams, underwire channels)
    // every column carries ink — taking the median across the full bbox width
    // inflates the floor and kills the thin outer edge signal. The inner band
    // captures "construction density" without poisoning the floor with the
    // outer silhouette itself.
    const innerLo = minX + Math.round(bboxW * 0.20);
    const innerHi = minX + Math.round(bboxW * 0.80);
    const medianCol = approxMedianNonZero(colTorso, innerLo, innerHi);
    const colNoiseFloor = Math.max(4, medianCol) * detectionParams.colNoiseMultiplier;
    // Keep a guard band around the axis so the center-front seam doesn't win.
    const axisGuard = Math.max(4, Math.round(bboxW * 0.08));
    const axisPx = Math.round(axisXpx);
    // Edge-proximity prior: rewards columns near bbox left/right edges so the
    // outer silhouette outscores interior cup seams (side-panel attach lines)
    // even when those carry more total ink. Linear falloff over a half-width;
    // beyond 50% of bboxW from the relevant edge the bonus is zero.
    const edgeBiasMax = 0.45;
    const colPeakScore = (x, edgePx) => {
      const axisDist = Math.abs(x - axisPx) / Math.max(1, bboxW);
      const edgeDist = Math.abs(x - edgePx) / Math.max(1, bboxW);
      const edgeBias = 1 + edgeBiasMax * Math.max(0, 1 - edgeDist * 2);
      return colSmooth[x] * (0.78 + Math.min(1, axisDist * 2.2) * 0.22) * edgeBias;
    };

    let sideLeftCol = -1, sideLeftStrength = 0;
    for (let x = minX + 1; x <= axisPx - axisGuard; x += 1) {
      const score = colPeakScore(x, minX);
      if (score > sideLeftStrength) {
        sideLeftStrength = score;
        sideLeftCol = x;
      }
    }
    const sideLeftX = (sideLeftCol > 0 && sideLeftStrength > colNoiseFloor * 1.3)
      ? sideLeftCol / w : null;

    let sideRightCol = -1, sideRightStrength = 0;
    for (let x = axisPx + axisGuard; x <= maxX - 1; x += 1) {
      const score = colPeakScore(x, maxX);
      if (score > sideRightStrength) {
        sideRightStrength = score;
        sideRightCol = x;
      }
    }
    const sideRightX = (sideRightCol > 0 && sideRightStrength > colNoiseFloor * 1.3)
      ? sideRightCol / w : null;

    _stageMark('verticalFeatures');

    // ---- Explicit geometry facts (Engineering Workflow Phase 5, items 1-2) ----
    // Make the frame geometry a first-class, self-describing output: center
    // axis, band line, the horizontal construction rows, the side-seam columns,
    // and the classified view regions — each in BOTH image-pixel and normalized
    // [0,1] space. This is a pure surfacing of values already computed above; no
    // detected coordinate changes, so anchors (and golden) are untouched. The
    // semantic-part facts (cup / strap / seam / back-panel candidates) and the
    // geometry-quality/review verdict are completed in the landmark stage, where
    // those parts exist — see detectLandmarks, which extends this same object.
    const sigConfLocal = (peak, floor) => clamp01((peak - floor) / Math.max(1, floor * 2));
    const geometryFacts = {
      space: 'image-pixel + normalized[0,1]',
      bbox: { ...bbox },
      bboxPx: { minX, minY, maxX, maxY, width: bboxW, height: bboxH },
      symmetryAxis: {
        xPx: Math.round(axisXpx),
        xNorm: axisX,
        symmetry,
        confidence: clamp01(symmetry),
      },
      bandLine: {
        yPx: bandEdgeRow >= 0 ? bandEdgeRow : null,
        yNorm: bandY,
        zoneRowPx: bandRow,
        strength: bandStrength,
        confidence: sigConfLocal(bandStrength, rowNoiseFloor),
      },
      horizontalLines: {
        chest: chestY != null ? { yPx: chestRow, yNorm: chestY, strength: chestStrength } : null,
        cradle: cradleY != null ? { yPx: cradleRow, yNorm: cradleY, strength: cradleStrength } : null,
        underbust: underbustY != null
          ? { yPx: underbustRow, yNorm: underbustY, runPx: underbustRunPx } : null,
      },
      sideSeamColumns: {
        left: sideLeftX != null
          ? { xPx: sideLeftCol, xNorm: sideLeftX, strength: sideLeftStrength } : null,
        right: sideRightX != null
          ? { xPx: sideRightCol, xNorm: sideRightX, strength: sideRightStrength } : null,
      },
      viewRegions: buildGeometryViewRegions(viewBoxesPx, viewClassification, primaryViewIndex, w, h),
      viewClassification: {
        primaryViewIndex,
        frontOuterIndex: viewClassification.frontOuterIndex,
        frontInnerIndex: viewClassification.frontInnerIndex,
        backIndex: viewClassification.backIndex,
        reviewRequired: !!viewClassification.reviewRequired,
      },
    };

    return {
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
    };
  }
