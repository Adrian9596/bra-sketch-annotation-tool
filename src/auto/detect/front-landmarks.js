// Front-view ink landmark finders: the "find one specific ink feature inside a
// view box" toolkit. Cup/strap join + apex pair validation (POM 16), front
// shoulder-strap start (POM 14), inner-cup top, cup width / silhouette edges /
// cup bottom (the ink support behind POM 9 / POM 10), and the side-seam
// top/bottom notch (POM 11). Also holds detectFeaturesInViewBox, the
// self-contained per-view mini feature pass. Every function here takes explicit
// (dark, w, h, bounds, ...) arguments and keeps no closure state.
//
// detectFeaturesInViewBox / findSideTopFromInk / findSideBottomFromInk are also
// used by the back view (src/auto/detect/back-landmarks.js, which therefore
// loads after this file). The cup decision engine that consumes these finders is
// src/auto/detect/cup-model.js; the stage that calls them is
// src/auto/detect/landmark-stage.js.
// Source part for app.js. Run `npm run build` after editing.

  // Per-view feature pass: a self-contained mini-detector that runs inside a
  // single view's bounding box. Used to give the back view its own axis,
  // chest/band rows, side seams, and ink endpoints — so back-view anchors
  // snap to actual ink rather than hardcoded view-box ratios.
  function detectFeaturesInViewBox(dark, w, h, viewBoxPx) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX;
    const minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX;
    const maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;

    // Local row/column ink counts restricted to the view box.
    const rowDark = new Uint32Array(h);
    const colDark = new Uint32Array(w);
    let count = 0;
    let xSum = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let rowCount = 0;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) {
          rowCount += 1;
          colDark[x] += 1;
          xSum += x;
          count += 1;
        }
      }
      rowDark[y] = rowCount;
    }
    if (count < 60) return null;
    const centroidX = xSum / count;
    const axisPx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);

    // Smoothed peak picks (mirror of the front-view logic).
    const rowSmooth = smooth1D(rowDark);
    const colSmooth = smooth1D(colDark);

    // Band: bottom 40% of the view height, strongest horizontal row.
    const rowRun = computeRowMaxRun(dark, w, minX, maxX, minY, maxY);
    const bandStart = Math.round(minY + bh * 0.58);
    let bandRow = -1; let bandStrength = 0;
    for (let y = bandStart; y <= maxY; y += 1) {
      if (rowSmooth[y] > bandStrength) { bandStrength = rowSmooth[y]; bandRow = y; }
    }
    const bandEdgeRow = snapBandToSolidEdge(rowRun, bandRow, minY, maxY, bw, bh);
    // Chest / top-band: upper 50% of the view height.
    const chestEnd = Math.round(minY + bh * 0.50);
    let chestRow = -1; let chestStrength = 0;
    for (let y = minY + Math.round(bh * 0.06); y <= chestEnd; y += 1) {
      if (rowSmooth[y] > chestStrength) { chestStrength = rowSmooth[y]; chestRow = y; }
    }

    // Side seams: strongest verticals on either side of the axis, with a
    // small guard band so the centerline doesn't win.
    const axisGuard = Math.max(4, Math.round(bw * 0.08));
    let sideLeftCol = -1, sideLeftStrength = 0;
    for (let x = minX + 1; x <= axisPx - axisGuard; x += 1) {
      if (colSmooth[x] > sideLeftStrength) { sideLeftStrength = colSmooth[x]; sideLeftCol = x; }
    }
    let sideRightCol = -1, sideRightStrength = 0;
    for (let x = axisPx + axisGuard; x <= maxX - 1; x += 1) {
      if (colSmooth[x] > sideRightStrength) { sideRightStrength = colSmooth[x]; sideRightCol = x; }
    }

    // Walk inward along chest / band rows to find ink endpoints.
    const halfRowBand = Math.max(2, Math.round(bh * 0.012));
    const chestLeftPx  = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, minX, maxX, +1) : -1;
    const chestRightPx = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, maxX, minX, -1) : -1;
    const bandLeftPx   = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, minX, maxX, +1) : -1;
    const bandRightPx  = bandEdgeRow > 0 ? findHorizontalInkBound(dark, w, bandEdgeRow, halfRowBand, maxX, minX, -1) : -1;

    // Walk down the symmetry axis to find the topmost ink (cleavage / strap
    // notch). halfColBand widens it slightly so a center-line off by 1px
    // still scores.
    const halfColBand = Math.max(2, Math.round(bw * 0.020));
    const axisTopPx = findVerticalInkBound(dark, w, axisPx, halfColBand, minY, maxY, +1);
    const axisBottomPx = findVerticalInkBound(dark, w, axisPx, halfColBand, maxY, minY, -1);

    return {
      bbox: {
        x: minX / w, y: minY / h,
        width: bw / w, height: bh / h,
      },
      axisX: axisPx / w,
      chestY:    chestRow >= 0 ? chestRow / h : null,
      bandY:     bandEdgeRow >= 0 ? bandEdgeRow / h : null,
      sideLeftX: sideLeftCol  > 0 ? sideLeftCol  / w : null,
      sideRightX:sideRightCol > 0 ? sideRightCol / w : null,
      chestLeftX:  chestLeftPx  > 0 ? chestLeftPx  / w : null,
      chestRightX: chestRightPx > 0 ? chestRightPx / w : null,
      bandLeftX:   bandLeftPx   > 0 ? bandLeftPx   / w : null,
      bandRightX:  bandRightPx  > 0 ? bandRightPx  / w : null,
      axisTopY:    axisTopPx    >= 0 ? axisTopPx    / h : null,
      axisBottomY: axisBottomPx >= 0 ? axisBottomPx / h : null,
    };
  }

  // rowHintNorm (US-084, optional): when the other side's join is trusted, scan
  // only a band around that row and score by PROXIMITY to it instead of by the
  // topmost-run preference. The top preference is what takes the bait on a high
  // stray feature, so a hinted retry must not reuse it — otherwise the retry
  // simply re-picks the same wrong run inside a smaller window.
  function findCupStrapJoinFromInk(dark, w, h, bounds, axisPx, chestRow, side, rowHintNorm) {
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const guard = Math.max(4, Math.round(bboxW * 0.075));
    let y1 = bounds.minY + Math.round(bboxH * 0.08);
    let y2 = Math.min(
      bounds.maxY,
      chestRow > 0 ? chestRow + Math.round(bboxH * 0.05) : bounds.minY + Math.round(bboxH * 0.48)
    );
    // Band half-height for a hinted retry. Wide enough to absorb a real
    // left/right height difference (TD pairs slant at most 0.0548) plus the
    // run-centre quantisation, narrow enough to exclude the stray that caused
    // the disagreement.
    const hinted = Number.isFinite(rowHintNorm);
    if (hinted) {
      const hintPx = rowHintNorm * h;
      const band = Math.max(3, Math.round(bboxH * 0.06));
      y1 = Math.max(y1, Math.round(hintPx - band));
      y2 = Math.min(y2, Math.round(hintPx + band));
    }
    const x1 = side < 0
      ? bounds.minX + Math.round(bboxW * 0.05)
      : axisPx + guard;
    const x2 = side < 0
      ? axisPx - guard
      : bounds.maxX - Math.round(bboxW * 0.05);
    if (x2 <= x1 || y2 <= y1) return null;

    const minSupport = Math.max(3, Math.round(bboxW * 0.012));
    const localRows = Math.max(5, Math.round(bboxH * 0.035));
    let best = null;
    for (let y = y1; y <= y2; y += 1) {
      const base = y * w;
      let runStart = -1;
      for (let x = x1; x <= x2 + 1; x += 1) {
        const on = x <= x2 && !!dark[base + x];
        if (on && runStart < 0) {
          runStart = x;
          continue;
        }
        if (on) continue;
        if (runStart < 0) continue;
        const startX = runStart;
        const runEnd = x - 1;
        const runWidth = runEnd - startX + 1;
        runStart = -1;
        if (runWidth < minSupport) continue;
        const cx = (startX + runEnd) / 2;
        if (side < 0 && cx > axisPx - guard) continue;
        if (side > 0 && cx < axisPx + guard) continue;

        let support = 0;
        let supportBottomY = y;
        const sx1 = Math.max(x1, Math.round(cx - bboxW * 0.035));
        const sx2 = Math.min(x2, Math.round(cx + bboxW * 0.035));
        for (let yy = y; yy <= Math.min(y2, y + localRows); yy += 1) {
          const b = yy * w;
          let rowSupport = 0;
          for (let xx = sx1; xx <= sx2; xx += 1) {
            if (dark[b + xx]) rowSupport += 1;
          }
          support += rowSupport;
          if (rowSupport > 0) supportBottomY = yy;
        }
        const verticalSpan = supportBottomY - y + 1;
        if (support < Math.max(minSupport * 2, verticalSpan * 2)) continue;
        // Reject decorative blobs (bow / scallop) sitting on the cup body
        // top. A real cup-strap join is the upper-outer corner of the cup,
        // so the cup BODY fills the rows below it — verticalSpan saturates
        // at localRows. A bow inked into the cup body lasts only a few
        // rows before its ribbon ends, leaving a gap below — verticalSpan
        // small. Require ≥ 40% of the lookahead window to be supported.
        if (verticalSpan < Math.max(3, Math.round((localRows + 1) * 0.4))) continue;

        const edgeBias = side < 0
          ? clamp01((axisPx - cx) / Math.max(1, bboxW * 0.45))
          : clamp01((cx - axisPx) / Math.max(1, bboxW * 0.45));
        const highCupBias = 1 - Math.min(1, (y - y1) / Math.max(1, y2 - y1));
        // Strongly (nonlinearly) prefer the TOPMOST qualifying run so the cup
        // top lands at the strap-cup join, not a denser lower band (e.g. lace
        // scallops or a cup-body seam). A lower band only wins when its support
        // dramatically outweighs the top's. The verticalSpan>=40% gate above
        // still requires real cup body below the pick, so this cannot snap onto
        // a thin strap-ribbon tick above the true cup seam.
        const topPref = 0.5 + 0.5 * highCupBias * highCupBias;
        // A hinted retry scores by nearness to the trusted row instead of by
        // height in the window — see the rowHintNorm note on this function.
        const rowPref = hinted
          ? 1 - Math.min(1, Math.abs(y - rowHintNorm * h) / Math.max(1, y2 - y1))
          : topPref;
        const score = support * rowPref * (0.75 + edgeBias * 0.25);
        // Tie-break: normally the higher run wins (cup top, not a lower seam);
        // on a hinted retry the run nearer the trusted row wins instead.
        const tieBreakWins = best && Math.abs(score - best.score) < 1e-6
          && (hinted
            ? Math.abs(y - rowHintNorm * h) < Math.abs(best.y - rowHintNorm * h)
            : y < best.y);
        if (!best || score > best.score || tieBreakWins) {
          best = {
            x: cx,
            // Inner edge of the strap ribbon at the join row — the edge nearer
            // the center front. POM 16 (apex distance) measures inner-edge to
            // inner-edge across the cup/front-strap joining seams, so the left
            // cup uses the run's right edge and the right cup its left edge.
            innerX: side < 0 ? runEnd : startX,
            // Outer edge (nearer the side seam) — POM 14's strap join anchor
            // sits on the OUTER edge of the join (ADR 0017, TD correction).
            outerX: side < 0 ? startX : runEnd,
            y,
            support,
            verticalSpan,
            score,
          };
        }
      }
    }
    if (!best) return null;

    const regionArea = Math.max(1, (x2 - x1 + 1) * (y2 - y1 + 1));
    const confidence = clamp01(0.18 + Math.min(0.42, best.support / Math.max(1, regionArea * 0.012))
      + Math.min(0.24, best.verticalSpan / Math.max(1, bboxH * 0.18))
      + Math.min(0.16, best.score / Math.max(1, bboxW)));
    if (confidence < 0.32) return null;
    return {
      point: { x: best.x / w, y: best.y / h },
      innerEdgeX: best.innerX / w,
      outerEdgeX: best.outerX / w,
      confidence,
      support: {
        count: best.support,
        verticalSpan: best.verticalSpan,
        score: Math.round(best.score * 100) / 100,
      },
    };
  }

  // US-084: cross-check the two cup/strap joins against each other.
  //
  // findCupStrapJoinFromInk runs once per side with no knowledge of the other,
  // and it deliberately prefers the TOPMOST qualifying run so the pick lands on
  // the strap join rather than a lower cup-body seam. When one side carries an
  // extra high feature that clears the support gates (a strap ribbon tick, a
  // trim line, a neckline binding crossing the search window), that preference
  // takes the bait on that side only. The result is a pair straddling two
  // different rows, which no per-side check can see: on demo7.png the left join
  // is exactly on the TD-labelled row while the right sits 0.134 above it.
  //
  // The two joins are near-symmetric features on a flat sketch. TD-labelled
  // pairs slant (dy/dx) by at most 0.0548, so a pair beyond APEX_SLANT_LIMIT is
  // a detection disagreement, not a garment property. Re-run the losing side
  // with the trusted side's row as a hint and keep the result only if it
  // genuinely reconciles the pair — otherwise leave both candidates untouched
  // and let validateCupApexPair / the POM 16 slant gate handle it, so a sketch
  // this cannot repair degrades exactly as before rather than getting a
  // fabricated anchor.
  const APEX_SLANT_LIMIT = 0.06;

  function apexPairSlant(left, right) {
    if (!left || !right) return null;
    const dx = Math.abs(right.point.x - left.point.x);
    if (!(dx > 0)) return Infinity;
    return Math.abs(left.point.y - right.point.y) / dx;
  }

  function repairApexPairRow(left, right, dark, w, h, bounds, axisPx, chestRow) {
    const slant = apexPairSlant(left, right);
    if (slant == null || slant <= APEX_SLANT_LIMIT) return { left, right, repaired: null };

    // Trust the more confident side; on a tie prefer the LOWER row, since the
    // failure mode this repairs is a pick that jumped UP off the cup.
    const leftWins = left.confidence > right.confidence + 1e-9
      || (Math.abs(left.confidence - right.confidence) <= 1e-9 && left.point.y >= right.point.y);
    const keep = leftWins ? left : right;
    const side = leftWins ? +1 : -1;   // re-search the OTHER side
    const retry = findCupStrapJoinFromInk(
      dark, w, h, bounds, axisPx, chestRow, side, keep.point.y);
    if (!retry) return { left, right, repaired: null };

    const next = leftWins ? { left, right: retry } : { left: retry, right };
    const nextSlant = apexPairSlant(next.left, next.right);
    // Only accept a retry that actually reconciles the pair.
    if (nextSlant == null || nextSlant > APEX_SLANT_LIMIT || nextSlant >= slant) {
      return { left, right, repaired: null };
    }
    return {
      left: next.left,
      right: next.right,
      repaired: {
        side: leftWins ? 'right' : 'left',
        fromY: (leftWins ? right : left).point.y,
        toY: retry.point.y,
        hintY: keep.point.y,
        slantBefore: slant,
        slantAfter: nextSlant,
      },
    };
  }

  function validateCupApexPair(left, right, bounds, w, h) {
    if (!left || !right) return null;
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const lx = left.point.x * w;
    const rx = right.point.x * w;
    const ly = left.point.y * h;
    const ry = right.point.y * h;
    if (rx <= lx + bboxW * 0.12) return null;
    if (Math.abs(ly - ry) > bboxH * 0.22) return null;
    if (left.confidence < 0.32 || right.confidence < 0.32) return null;
    return { left, right };
  }

  // (Removed dead findCupApexFromInk: never referenced — the live pipeline
  // uses findCupStrapJoinFromInk / buildCupModel for apex detection.)

  // Front shoulder-strap start for POM 14. The TD measurement starts at the
  // upper joining seam of the stitched/elastic front strap section (the first
  // clear cross-strap seam above the cup), not at the cup/strap apex and not
  // at the topmost silhouette ink. Search a narrow column around the validated
  // left cup/strap join and choose the highest substantial horizontal run.
  // apexInfo is the cup/strap join the strap rises from — the RIGHT join on a
  // standard two-view sheet (ADR 0016), falling back to the left join when the
  // right one wasn't validated.
  function findFrontStrapStartFromInk(dark, w, h, bounds, apexInfo, chestRow) {
    if (!apexInfo || !apexInfo.point) return null;
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const cx = Math.round(apexInfo.point.x * w);
    const apexY = Math.round(apexInfo.point.y * h);
    const y1 = Math.max(bounds.minY + Math.round(bboxH * 0.025), 1);
    const y2 = Math.min(
      apexY - Math.max(3, Math.round(bboxH * 0.035)),
      chestRow > 0 ? chestRow - 2 : bounds.maxY);
    const halfWindow = Math.max(6, Math.round(bboxW * 0.055));
    const x1 = Math.max(bounds.minX, cx - halfWindow);
    const x2 = Math.min(bounds.maxX, cx + halfWindow);
    const minRun = Math.max(4, Math.round(bboxW * 0.014));
    const maxRun = Math.max(minRun + 2, Math.round(bboxW * 0.11));
    if (y2 <= y1 || x2 <= x1) return null;

    let best = null;
    for (let y = y1; y <= y2; y += 1) {
      const base = y * w;
      let runStart = -1;
      for (let x = x1; x <= x2 + 1; x += 1) {
        const on = x <= x2 && !!dark[base + x];
        if (on && runStart < 0) runStart = x;
        if (on) continue;
        if (runStart < 0) continue;
        const runEnd = x - 1;
        const runWidth = runEnd - runStart + 1;
        const runCenter = (runStart + runEnd) / 2;
        runStart = -1;
        if (runWidth < minRun || runWidth > maxRun) continue;
        if (Math.abs(runCenter - cx) > halfWindow * 0.62) continue;

        // A joining seam is supported by strap ink immediately below it.
        // This rejects an isolated crop/silhouette cap at the top of the view.
        let belowSupport = 0;
        const supportDepth = Math.max(4, Math.round(bboxH * 0.025));
        for (let yy = y + 1; yy <= Math.min(y2, y + supportDepth); yy += 1) {
          const b = yy * w;
          for (let xx = Math.max(x1, Math.round(runCenter - minRun));
            xx <= Math.min(x2, Math.round(runCenter + minRun)); xx += 1) {
            if (dark[b + xx]) belowSupport += 1;
          }
        }
        if (belowSupport < supportDepth * 2) continue;

        // Prefer the LOWEST valid seam — the joining seam at the top of the
        // stitched (zigzag) section sits nearest the cup join; the zigzag ink
        // itself only yields sub-minRun runs so it can't win. Preferring the
        // topmost run (pre-ADR-0016) landed on the strap cap / top of the
        // elastic stripes, which the TD flagged as too high. Width/support
        // break ties between adjacent antialiased rows of the same seam.
        const score = runWidth + Math.min(minRun * 2, belowSupport / Math.max(1, supportDepth));
        if (!best || y > best.y + 2 || (Math.abs(y - best.y) <= 2 && score > best.score)) {
          best = { x: runCenter, y, runWidth, belowSupport, score };
        }
      }
    }
    if (!best) return null;
    const confidence = clamp01(0.28
      + Math.min(0.36, best.runWidth / Math.max(1, minRun * 2) * 0.22)
      + Math.min(0.28, best.belowSupport / Math.max(1, bboxH * 0.08)));
    return {
      point: { x: best.x / w, y: best.y / h },
      confidence,
      support: { runWidth: best.runWidth, belowSupport: best.belowSupport },
    };
  }

  function findStrapLandmarksFromInk(dark, w, h, bounds, axisPx, chestRow) {
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const y1 = bounds.minY;
    const y2 = Math.min(bounds.maxY, chestRow > 0 ? chestRow : bounds.minY + Math.round(bboxH * 0.34));
    if (y2 <= y1 + 3) return null;

    const scanSide = (side) => {
      const x1 = side < 0 ? bounds.minX : axisPx + Math.round(bboxW * 0.08);
      const x2 = side < 0 ? axisPx - Math.round(bboxW * 0.08) : bounds.maxX;
      if (x2 <= x1) return null;
      let count = 0;
      let topY = h, topXSum = 0, topCount = 0;
      let bottomY = -1, bottomXSum = 0, bottomCount = 0;
      for (let y = y1; y <= y2; y += 1) {
        const base = y * w;
        let rowXSum = 0, rowCount = 0;
        for (let x = x1; x <= x2; x += 1) {
          if (!dark[base + x]) continue;
          count += 1;
          rowXSum += x;
          rowCount += 1;
        }
        if (rowCount > 0) {
          if (y < topY) { topY = y; topXSum = rowXSum; topCount = rowCount; }
          if (y > bottomY) { bottomY = y; bottomXSum = rowXSum; bottomCount = rowCount; }
        }
      }
      if (count < Math.max(6, (x2 - x1 + 1) * (y2 - y1 + 1) * 0.0015)) return null;
      return {
        count,
        top: { x: (topXSum / Math.max(1, topCount)) / w, y: topY / h },
        bottom: { x: (bottomXSum / Math.max(1, bottomCount)) / w, y: bottomY / h },
      };
    };

    const left = scanSide(-1);
    const right = scanSide(+1);
    const chosen = right && (!left || right.count >= left.count * 0.85) ? right : left;
    if (!chosen) return null;
    return {
      top: chosen.top,
      bottom: chosen.bottom,
      confidence: clamp01(0.25 + Math.min(0.65, chosen.count / Math.max(1, bboxW * bboxH * 0.03))),
    };
  }

  // Topmost dark pixel in the +/-30% horizontal strip around the axis, BELOW
  // chestRow. This is the high point of the inner-cup construction curves —
  // the audit's anchor for POM 9 (inner cup height) and POM 10 (inner cup
  // width). Returns { point: {x, y}, confidence } in normalized coords.
  function findInnerCupTopFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 12 || bboxH < 12) return null;
    const stripHalf = Math.max(4, Math.round(bboxW * 0.30));
    const xLo = Math.max(minX, axisPx - stripHalf);
    const xHi = Math.min(maxX, axisPx + stripHalf);
    // Skip the chest-row band itself so we don't pin to the chest line ink.
    const guardBelowChest = Math.max(3, Math.round(bboxH * 0.04));
    const yLo = (chestRow > 0 ? chestRow : minY + Math.round(bboxH * 0.30)) + guardBelowChest;
    const yHi = (bandRow > 0 ? bandRow : maxY) - Math.max(4, Math.round(bboxH * 0.10));
    if (yHi <= yLo || xHi <= xLo) return null;
    // Find first row in [yLo, yHi] with at least a few ink pixels in strip.
    const minInkPerRow = Math.max(2, Math.round((xHi - xLo + 1) * 0.05));
    let topY = -1, topX = axisPx, topInk = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let inkCount = 0, xSum = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { inkCount += 1; xSum += x; }
      }
      if (inkCount >= minInkPerRow) {
        topY = y;
        topX = xSum / inkCount;
        topInk = inkCount;
        break;
      }
    }
    if (topY < 0) return null;
    // Confidence scales with how much ink we found on the winning row.
    const confidence = clamp01(0.35 + Math.min(0.45, topInk / Math.max(1, xHi - xLo + 1)));
    return { point: { x: topX / w, y: topY / h }, confidence };
  }

  // POM 10 width from real cup ink. Walks the cup-body band [apexY..seamY]
  // on the picked cup half, finds the widest ink-supported row, and returns
  // its leftmost/rightmost ink columns re-labeled as inner (near CF axis) /
  // outer (near side seam) for that side. Returns null when ink is too
  // sparse or the widest row still doesn't span a real cup extent — the
  // caller then keeps its fixed-inset priors so nothing downstream regresses.
  function findCupWidthFromInk(dark, w, h, bounds, axisPx, sideColPx, apexY, seamY, side, targetY, searchWindow) {
    if (!dark || !w || !h) return null;
    if (apexY == null || seamY == null || seamY <= apexY) return null;
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const cupHeightPx = (seamY - apexY) * h;
    if (cupHeightPx < 20) return null;
    // Row band to scan. When a searchWindow {loY,hiY} is given, scan that whole
    // caller-supplied band (already clamped to the A6-legal region) and take the
    // widest coherent cup-ink run — used for deep cups whose true widest seam
    // sits below the fixed upper-middle level. When a targetY is given, scan a
    // narrow band around it (the legacy fixed-level probe). Otherwise scan the
    // cup body proper — skipping the strap-junction band right below the apex
    // (top 20%) and the cradle-transition band above the seam (bottom 15%) — and
    // take the widest row overall.
    let yLo, yHi;
    if (searchWindow && Number.isFinite(searchWindow.loY) && Number.isFinite(searchWindow.hiY)
        && searchWindow.hiY > searchWindow.loY) {
      yLo = Math.max(minY + 1, Math.round(clamp01(searchWindow.loY) * h));
      yHi = Math.min(maxY - 1, Math.round(clamp01(searchWindow.hiY) * h));
    } else if (targetY != null) {
      const bandPx = Math.max(3, Math.round(cupHeightPx * 0.06));
      const cy = Math.round(clamp01(targetY) * h);
      yLo = Math.max(minY + 1, cy - bandPx);
      yHi = Math.min(maxY - 1, cy + bandPx);
    } else {
      yLo = Math.max(minY + 1, Math.round(apexY * h + cupHeightPx * 0.20));
      yHi = Math.min(maxY - 1, Math.round(seamY * h - cupHeightPx * 0.15));
    }
    if (yHi <= yLo + 2) return null;
    // Keep the x search clear of both the CF axis and the side seam so we
    // never match seam ink itself.
    const axisGuard = Math.max(2, Math.round(bboxW * 0.02));
    const seamGuard = Math.max(2, Math.round(bboxW * 0.015));
    let xLo, xHi;
    if (side < 0) {
      xLo = Math.max(minX + 1, sideColPx + seamGuard);
      xHi = Math.min(maxX - 1, axisPx - axisGuard);
    } else {
      xLo = Math.max(minX + 1, axisPx + axisGuard);
      xHi = Math.min(maxX - 1, sideColPx - seamGuard);
    }
    if (xHi <= xLo + 4) return null;
    const cupHalfWidthPx = Math.max(1, Math.abs(sideColPx - axisPx));
    // Require the run to span a real cup extent (≥45% of the cup half-width).
    // A narrower run at the targeted upper level is usually a fragment trapped
    // between internal cup seams (not the gore→outer span), so we reject it and
    // let the caller use its straddling axis/side inset prior instead.
    const minCupWidthPx = Math.max(6, Math.round(cupHalfWidthPx * 0.45));
    let bestY = -1, bestLeft = -1, bestRight = -1, bestWidth = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let firstInk = -1, lastInk = -1;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) {
          if (firstInk < 0) firstInk = x;
          lastInk = x;
        }
      }
      if (firstInk < 0) continue;
      const runWidth = lastInk - firstInk + 1;
      if (runWidth < minCupWidthPx) continue;
      if (runWidth > bestWidth) {
        bestWidth = runWidth;
        bestLeft = firstInk;
        bestRight = lastInk;
        bestY = y;
      }
    }
    if (bestY < 0) return null;
    // On the LEFT cup the inner (near-axis) edge is the RIGHTMOST ink pixel
    // and the outer (near-seam) edge is the LEFTMOST. On the RIGHT cup it
    // flips. seed-anchors.js separately assigns inner-cup-left/right by x
    // ordering so canvas geometry stays left→right regardless of cup side.
    const innerPx = side < 0 ? bestRight : bestLeft;
    const outerPx = side < 0 ? bestLeft  : bestRight;
    return {
      centerY: bestY / h,
      innerX: innerPx / w,
      outerX: outerPx / w,
      widthPx: bestWidth,
      widthFrac: bestWidth / cupHalfWidthPx,
    };
  }

  // Cup OUTER silhouette edge at a single row. Scans INWARD from the view's
  // outer (armhole-side) bbox edge toward the CF axis and returns the first
  // coherent ink run — the cup's outer outline at that row. Unlike
  // findCupWidthFromInk this is NOT capped at the detected side-seam column, so
  // it recovers the true cup edge when sideColPx lands inboard of the silhouette
  // (POM 10 must span the FULL cup width — CF gore → outer armhole edge).
  // Returns the pixel x of the outline, or null. side<0 = left cup.
  function findCupOuterSilhouettePx(dark, w, h, bounds, axisPx, rowPx, side) {
    if (!dark || !w || !h) return null;
    const { minX, minY, maxX, maxY } = bounds;
    if (rowPx <= minY || rowPx >= maxY) return null;
    const base = rowPx * w;
    const guard = Math.max(2, Math.round((maxX - minX + 1) * 0.02));
    if (side < 0) {
      const xStop = axisPx - guard;
      for (let x = minX + 1; x < xStop; x += 1) {
        if (dark[base + x] && dark[base + x + 1]) return x; // first 2px run
      }
    } else {
      const xStop = axisPx + guard;
      for (let x = maxX - 1; x > xStop; x -= 1) {
        if (dark[base + x] && dark[base + x - 1]) return x;
      }
    }
    return null;
  }

  // Cup INNER silhouette (seam) at a single row. Scans from just off the CF
  // axis OUTWARD toward the cup center and returns the first coherent ink run —
  // the cup's inner seam where it meets the center gore. On wide-gore styles
  // the gore is faint mesh (below the ink threshold), so the scan skips it and
  // lands on the cup panel's inner edge; on narrow gores it stops near the axis
  // ≈ the gore inset. Bounded by cupCenterPx so it never crosses to the outer
  // half. Returns the pixel x, or null. side<0 = left cup (inner edge is right).
  function findCupInnerSilhouettePx(dark, w, h, bounds, axisPx, cupCenterPx, rowPx, side, startInsetPx) {
    if (!dark || !w || !h) return null;
    const { minX, minY, maxX, maxY } = bounds;
    if (rowPx <= minY || rowPx >= maxY) return null;
    const base = rowPx * w;
    if (side < 0) {
      const xStart = Math.min(maxX - 1, axisPx - startInsetPx);
      const xStop = Math.max(minX + 1, cupCenterPx);   // don't cross cup center
      for (let x = xStart; x > xStop; x -= 1) {
        if (dark[base + x] && dark[base + x - 1]) return x;
      }
    } else {
      const xStart = Math.max(minX + 1, axisPx + startInsetPx);
      const xStop = Math.min(maxX - 1, cupCenterPx);
      for (let x = xStart; x < xStop; x += 1) {
        if (dark[base + x] && dark[base + x + 1]) return x;
      }
    }
    return null;
  }

  // Confirm/refine the cup's OWN underwire bottom from the dark mask. The
  // global cradleY is a single horizontal row for the whole garment; this
  // instead looks for the lowest COHERENT ink arc within the cup's central
  // columns — the underwire dips near cup center (per the POM 9 reference,
  // cup height runs to that lowest wire point). We keep the result close to
  // cradleY (a validation, not a relocation): if a real arc is found near the
  // cradle row under this cup, POM 9's bottom becomes trustworthy (earned
  // confidence) instead of a flat guess. Returns { bottomY, support } or null.
  function findCupBottomFromInk(dark, w, h, bounds, axisPx, sideColPx, apexY, cradleY, side) {
    if (!dark || !w || !h) return null;
    if (apexY == null || cradleY == null) return null;
    const { minX, minY, maxX, maxY } = bounds;
    const bboxH = maxY - minY + 1;
    // Central portion of the cup x-band — the wire bottoms near cup center,
    // not out at the side seam nor hard against the CF gore.
    const loX = Math.min(axisPx, sideColPx);
    const hiX = Math.max(axisPx, sideColPx);
    const bandW = hiX - loX;
    if (bandW < 8) return null;
    const cLo = Math.max(minX + 1, Math.round(loX + bandW * 0.20));
    const cHi = Math.min(maxX - 1, Math.round(hiX - bandW * 0.20));
    if (cHi <= cLo + 2) return null;
    // Vertical window: clearly below the apex, down to just past the cradle
    // row (the wire can dip a little below it) but never into the band hem.
    const yTop = Math.round(apexY * h + bboxH * 0.10);
    const yBot = Math.min(maxY - 1, Math.round(clamp01(cradleY + 0.05) * h));
    if (yBot <= yTop + 4) return null;
    let cols = 0, hit = 0;
    const bottoms = [];
    for (let x = cLo; x <= cHi; x += 1) {
      cols += 1;
      let low = -1;
      for (let y = yBot; y >= yTop; y -= 1) {
        if (dark[y * w + x]) {
          // Require a short vertical run so a lone speck doesn't win.
          let run = 0;
          for (let k = 0; k < 4 && (y - k) >= yTop; k += 1) if (dark[(y - k) * w + x]) run += 1;
          if (run >= 2) { low = y; break; }
        }
      }
      if (low >= 0) { bottoms.push({ x, low }); hit += 1; }
    }
    if (hit < Math.max(3, Math.round(cols * 0.30))) return null; // not a coherent arc
    const lows = bottoms.slice();  // (x, low) pairs preserved below
    bottoms.sort((a, b) => a.low - b.low);
    // 80th percentile of per-column lowest points — robust to a few short cols.
    const idx = Math.min(bottoms.length - 1, Math.round(bottoms.length * 0.80));
    const chosenY = bottoms[idx].low;
    // Arc-bottom column: median x of the columns within 2px of the deepest
    // point — the flat center of the wire dip (used by the POM 7 arc tier).
    const deep = lows.filter((b) => b.low >= chosenY - 2).map((b) => b.x).sort((a, b) => a - b);
    const bottomX = deep.length ? deep[Math.floor(deep.length / 2)] / w : null;
    return { bottomY: chosenY / h, bottomX, support: hit / cols };
  }

  // Underarm notch on one side: starting at the detected side-seam column,
  // scan upward from chestRow looking for the topmost dark pixel within a
  // small lateral window. The result is the side-top anchor for POM 11.
  function findSideTopFromInk(dark, w, h, bounds, sideCol, chestRow, side) {
    if (sideCol == null || sideCol < 0) return null;
    const { minX, minY, maxX } = bounds;
    const bboxW = maxX - minX + 1;
    const lateralHalf = Math.max(3, Math.round(bboxW * 0.025));
    const xLo = Math.max(minX, sideCol - lateralHalf);
    const xHi = Math.min(maxX, sideCol + lateralHalf);
    const yLo = minY;
    const yHi = chestRow > 0 ? chestRow : bounds.maxY;
    if (yHi <= yLo || xHi <= xLo) return null;
    let topY = -1, topXSum = 0, topCount = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) {
        topY = y; topXSum = rowSum; topCount = rowCount;
        break;
      }
    }
    if (topY < 0) return null;
    const topX = topXSum / topCount;
    const confidence = clamp01(0.4 + Math.min(0.4, (chestRow > 0 ? (chestRow - topY) / Math.max(1, bounds.maxY - bounds.minY) : 0) * 1.5));
    return { point: { x: topX / w, y: topY / h }, confidence, side };
  }

  // From a detected side-top, follow the side-seam OUTLINE downward to the
  // bottom hem. A real side seam slants inward (it is rarely a vertical edge),
  // so we edge-walk the ink nearest the previous column each row — tolerating
  // small gaps where the band line crosses — instead of holding the top column.
  // The lowest tracked point is the side-bottom anchor for POM 11.
  function findSideBottomFromInk(dark, w, h, bounds, topPoint) {
    if (!topPoint) return null;
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    let lastX = Math.round(topPoint.x * w);
    const startY = Math.round(topPoint.y * h) + 1;
    if (startY >= maxY || lastX < minX || lastX > maxX) return null;
    const lateralHalf = Math.max(3, Math.round(bboxW * 0.05));
    const maxGap = Math.max(4, Math.round((maxY - minY) * 0.05));
    let bestX = lastX, bestY = -1, gap = 0, rows = 0;
    for (let y = startY; y <= maxY; y += 1) {
      const base = y * w;
      const xLo = Math.max(minX, lastX - lateralHalf);
      const xHi = Math.min(maxX, lastX + lateralHalf);
      let nearestX = -1, nearestDist = Infinity;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) {
          const d = Math.abs(x - lastX);
          if (d < nearestDist) { nearestDist = d; nearestX = x; }
        }
      }
      if (nearestX < 0) { gap += 1; if (gap > maxGap) break; continue; }
      gap = 0; lastX = nearestX; bestX = nearestX; bestY = y; rows += 1;
    }
    if (bestY < 0 || rows < 3) return null;
    const confidence = clamp01(0.35 + Math.min(0.45, rows / Math.max(1, maxY - minY)));
    return { point: { x: bestX / w, y: bestY / h }, confidence };
  }
