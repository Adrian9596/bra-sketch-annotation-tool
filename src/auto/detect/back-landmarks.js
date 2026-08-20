// Back-view landmark finders — the back-view counterpart of
// src/auto/detect/front-landmarks.js. Serves POM 11 (side seam), POM 12 (back
// center length), POM 13 (back panel height) and POM 15 (back strap distance):
// back center axis / top / bottom, back panel edges and height, back strap top
// and strap inner edges, and the back side seam as corner endpoints.
//
// detectBackLandmarks bundles the whole pass so the SAME pass can re-run after a
// TD view-role correction; redetectBackLandmarks is that re-run entry point and
// deliberately mutates an already-finished detection object in place (ADR 0035 /
// US-045 three-view boards) — it is a post-pipeline edge operation, not a stage.
//
// Shares detectFeaturesInViewBox / findSideTopFromInk / findSideBottomFromInk
// with src/auto/detect/front-landmarks.js and the row/column ink primitives with
// src/auto/detect/view-boxes.js, so this part must load after both.
// Source part for app.js. Run `npm run build` after editing.

  // Back-view strap-top: walk the left strap zone above the back chest row to
  // find the topmost ink. On a back technical sketch the strap rises from the
  // back-panel top toward the shoulder. Returns null when the strap zone has
  // no ink.
  function findBackStrapTopFromInk(dark, w, h, viewBoxPx, chestRow) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX;
    const minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX;
    const maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;
    const yEnd = (chestRow > 0 && chestRow > minY)
      ? Math.min(maxY, chestRow)
      : minY + Math.round(bh * 0.45);
    const xLo = minX + Math.round(bw * 0.05);
    const xHi = minX + Math.round(bw * 0.32);
    if (xHi <= xLo) return null;
    let total = 0;
    for (let y = minY; y <= yEnd; y += 1) {
      const base = y * w;
      let rowCount = 0;
      let rowXSum = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowCount += 1; rowXSum += x; }
      }
      total += rowCount;
      if (rowCount > 0) {
        const cx = rowXSum / rowCount;
        return {
          point: { x: cx / w, y: y / h },
          confidence: clamp01(0.3 + Math.min(0.55, total / Math.max(1, bw * bh * 0.02))),
        };
      }
    }
    return null;
  }

  // Back-view shoulder-strap INNER edges (POM 15, back strap distance).
  // The two straps are near-vertical bands descending from the top of the back
  // view down to the attach (chest) row; the panel body and wing outlines only
  // begin AT/below that row, so scanning the zone [top .. chestRow] isolates the
  // straps from everything else. For each column we count ink over the zone; a
  // column that carries ink through most of the zone height is "strap ink". The
  // LEFT strap's inner edge is the right-most strap column left of the axis; the
  // RIGHT strap's inner edge is the left-most strap column right of the axis.
  // A narrow dead-center guard keeps a center-back construction line from being
  // mistaken for a strap edge. Returns normalized {left,right,confidence} or null.
  function findBackStrapInnerEdges(dark, w, h, viewBoxPx, chestRow, axisPx) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX, minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX, maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < 24 || bh < 24) return null;
    const yTop = minY;
    const yBot = (chestRow > minY && chestRow < maxY)
      ? chestRow
      : minY + Math.round(bh * 0.32);
    const zoneH = yBot - yTop;
    if (zoneH < Math.max(8, Math.round(bh * 0.08))) return null;
    const axis = (axisPx > minX && axisPx < maxX)
      ? axisPx
      : Math.round((minX + maxX) / 2);
    // Per-column ink count over the strap zone.
    const counts = new Array(bw).fill(0);
    for (let y = yTop; y <= yBot; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) counts[x - minX] += 1;
      }
    }
    // Strap columns carry near-vertical ink over most of the zone height.
    const colThresh = Math.max(3, Math.round(zoneH * 0.40));
    // Dead-center guard: strap edges never sit on the axis (there is always a
    // neckline gap), so ignore columns within ~2% of bbox width of the axis.
    const guard = Math.max(1, Math.round(bw * 0.02));
    let leftInnerI = -1, rightInnerI = -1;
    for (let i = 0; i < bw; i += 1) {
      if (counts[i] < colThresh) continue;
      const x = minX + i;
      if (x < axis - guard) leftInnerI = i;              // keep last → right-most
      else if (x > axis + guard && rightInnerI < 0) rightInnerI = i; // first → left-most
    }
    if (leftInnerI < 0 || rightInnerI < 0) return null;
    const leftInnerXpx = minX + leftInnerI;
    const rightInnerXpx = minX + rightInnerI;
    if (!(leftInnerXpx < axis && rightInnerXpx > axis)) return null;
    // Require a real neckline gap between the inner edges.
    if (rightInnerXpx - leftInnerXpx < Math.round(bw * 0.05)) return null;
    const yPx = (chestRow > minY && chestRow < maxY) ? chestRow : yBot;
    const edgeInk = (counts[leftInnerI] + counts[rightInnerI]) / (2 * Math.max(1, zoneH));
    const confidence = clamp01(0.40 + 0.35 * Math.min(1, edgeInk));
    return {
      left:  { x: leftInnerXpx / w, y: yPx / h },
      right: { x: rightInnerXpx / w, y: yPx / h },
      confidence,
    };
  }

  // Back-view landmarks. Given the back view's pixel-space bbox, finds:
  //   - the back symmetry axis (vertical line through the center-back seam)
  //   - back-center-top: topmost ink in a thin strip around the axis. On a
  //     U-cutout back this is the bottom of the U; on a closed top this is the
  //     band's top edge.
  //   - back-center-bottom: bottommost ink in the same strip. The band's
  //     bottom edge at center.
  // POM 12 (back center length) is back-center-top → back-center-bottom.
  function findBackCenterLandmarks(dark, w, h, bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 8 || bboxH < 8) return null;

    let xSum = 0, xWeight = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) { xSum += x; xWeight += 1; }
      }
    }
    if (xWeight === 0) return null;
    const centroidX = xSum / xWeight;
    const axisPx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);
    const symmetry = computeSymmetryScore(dark, w, axisPx, minX, maxX, minY, maxY);

    // Strip half-width around the axis. Wide enough to survive a faint U-curve
    // crossing the axis at an angle, narrow enough to skip strap tabs at the
    // top corners.
    const halfStripPx = Math.max(2, Math.round(bboxW * 0.035));
    const xLo = Math.max(minX, axisPx - halfStripPx);
    const xHi = Math.min(maxX, axisPx + halfStripPx);

    let topY = -1;
    for (let y = minY; y <= maxY && topY < 0; y += 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { topY = y; break; }
      }
    }
    let bottomY = -1;
    for (let y = maxY; y >= minY && bottomY < 0; y -= 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { bottomY = y; break; }
      }
    }
    if (topY < 0 || bottomY < 0) return null;
    const spanPx = bottomY - topY;
    if (spanPx < bboxH * 0.15) return null;

    // Refine X at the top/bottom rows by taking the centroid of ink in the
    // strip on that row. This keeps the point on the actual edge ink instead
    // of pinning to the global symmetry axis when the edge curls slightly.
    const rowCentroid = (y) => {
      const base = y * w;
      let sum = 0, count = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { sum += x; count += 1; }
      }
      return count > 0 ? sum / count : axisPx;
    };
    const topX = rowCentroid(topY);
    const botX = rowCentroid(bottomY);

    return {
      axisX: axisPx / w,
      top: { x: topX / w, y: topY / h },
      bottom: { x: botX / w, y: bottomY / h },
      symmetry,
      bandHeightFrac: spanPx / Math.max(1, bboxH),
      confidence: clamp01(0.30 + 0.45 * symmetry + Math.min(0.25, spanPx / Math.max(1, bboxH))),
    };
  }

  // Back-view side seam as CORNER endpoints, not silhouette guesses. The side
  // seam's two ends are junctions: the TOP is where the side meets the armhole
  // (the armpit), the BOTTOM is where the side meets the band. We walk the outer
  // silhouette (leftmost ink per row — the back view's side is on its left),
  // find the armpit as the outermost extremum (a corner that exists at any
  // proportion, no fixed ratio), fit a line to the straight seam between, and
  // place the bottom corner on that line at the detected band row so POM 11 and
  // the band agree at the same point. `bandYpx` is the back band row (full-image
  // px), or <0 to fall back to the hem.
  function findBackSideSeam(dark, w, h, bounds, bandYpx) {
    const { minX, minY, maxX, maxY } = bounds;
    const H = maxY - minY + 1;
    if (H < 24) return null;
    const leftEdge = (y) => { const base = y * w; for (let x = minX; x <= maxX; x += 1) if (dark[base + x]) return x; return -1; };

    const ys = [], xs = [];
    for (let y = minY; y <= maxY; y += 1) { const x = leftEdge(y); if (x >= 0) { ys.push(y); xs.push(x); } }
    if (ys.length < 8) return null;
    const yHem = ys[ys.length - 1];

    // TOP corner = armpit: outermost (leftmost) silhouette point below the strap
    // sliver. A true extremum, so it lands on the armhole∩side junction whatever
    // the style's vertical proportions are.
    const skipTop = minY + Math.round(H * 0.10);
    const armMax = minY + Math.round(H * 0.72);
    let yTop = -1, xTop = Infinity;
    for (let i = 0; i < ys.length; i += 1) {
      if (ys[i] < skipTop || ys[i] > armMax) continue;
      if (xs[i] < xTop) { xTop = xs[i]; yTop = ys[i]; }
    }
    if (yTop < 0) return null;

    // Fit x = m*y + b to the straight seam rows (below the armpit, above the
    // hem). POM 11 is a straight line between its corners, so this denoises the
    // seam and lets the bottom corner sit exactly on it.
    let n = 0, sy = 0, sx = 0, syy = 0, sxy = 0;
    const fitLo = yTop + Math.round(H * 0.06), fitHi = yHem - Math.round(H * 0.05);
    for (let i = 0; i < ys.length; i += 1) {
      const y = ys[i];
      if (y < fitLo || y > fitHi) continue;
      n += 1; sy += y; sx += xs[i]; syy += y * y; sxy += xs[i] * y;
    }
    let m = 0, b = xTop;
    if (n >= 4) { const d = n * syy - sy * sy; if (Math.abs(d) > 1e-6) { m = (n * sxy - sy * sx) / d; b = (sx - m * sy) / n; } }
    const lineX = (y) => m * y + b;

    // BOTTOM corner = side∩band junction, on the SOLID hem line — not a zig-zag
    // elastic line drawn above it. Scanned row by row, a zig-zag has only short
    // horizontal runs (its diagonal strokes crossing each row), while the hem is
    // one long continuous run. So we pick the LOWEST row whose max horizontal run
    // reads as a solid line: that lands the corner on the bottom edge under any
    // decorative stitching. The band/hem fallback covers sketches with no clear
    // solid line.
    const W = maxX - minX + 1;
    const rowRun = computeRowMaxRun(dark, w, minX, maxX, minY, maxY);
    const yLo = minY + Math.round(H * 0.45);
    let peakRun = 0;
    for (let y = yLo; y <= maxY; y += 1) if (rowRun[y] > peakRun) peakRun = rowRun[y];
    let yBottom = (bandYpx != null && bandYpx > yTop && bandYpx <= maxY) ? bandYpx : yHem;
    if (peakRun >= W * 0.18) {
      const solidThresh = Math.max(W * 0.18, peakRun * 0.5);
      for (let y = maxY; y >= yLo; y -= 1) { if (rowRun[y] >= solidThresh) { yBottom = y; break; } }
    }
    let xBottom = n >= 4 ? lineX(yBottom) : (leftEdge(yBottom) >= 0 ? leftEdge(yBottom) : xTop);
    xBottom = Math.max(minX, Math.min(maxX, xBottom));

    return { top: { x: xTop / w, y: yTop / h }, bottom: { x: xBottom / w, y: yBottom / h }, confidence: 0.55 };
  }

  // Back-panel edges: contour-following at ~22% from the back-view's left.
  // The audit calls out the existing inView(b, 0.225, 0.439) and especially
  // inView(b, 0.232, 1.005) — the latter clamps off-image. Find real ink
  // top/bottom along that strip instead.
  function findBackPanelEdges(dark, w, h, bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 16 || bboxH < 16) return null;
    // Find the strongest vertical-ink column in the inner 10–45% zone of the
    // back view. This adapts to panel width instead of assuming a fixed 22.5%.
    // A minimum ink count guards against stray dots winning over real seams.
    const searchLo = minX + Math.round(bboxW * 0.10);
    const searchHi = minX + Math.round(bboxW * 0.45);
    const colCounts = new Uint32Array(w);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = searchLo; x <= searchHi; x += 1) {
        if (dark[base + x]) colCounts[x] += 1;
      }
    }
    let bestCol = -1, bestCount = 0;
    for (let x = searchLo; x <= searchHi; x += 1) {
      if (colCounts[x] > bestCount) { bestCount = colCounts[x]; bestCol = x; }
    }
    // Require meaningful ink density — rejects empty strips and stray dots.
    if (bestCol < 0 || bestCount < Math.max(8, Math.round(bboxH * 0.15))) return null;
    const stripCenter = bestCol;
    const stripHalf = Math.max(3, Math.round(bboxW * 0.04));
    const xLo = Math.max(minX, stripCenter - stripHalf);
    const xHi = Math.min(maxX, stripCenter + stripHalf);
    if (xHi <= xLo) return null;
    let topY = -1, topXSum = 0, topCount = 0;
    for (let y = minY; y <= maxY && topY < 0; y += 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) { topY = y; topXSum = rowSum; topCount = rowCount; }
    }
    let botY = -1, botXSum = 0, botCount = 0;
    for (let y = maxY; y >= minY && botY < 0; y -= 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) { botY = y; botXSum = rowSum; botCount = rowCount; }
    }
    if (topY < 0 || botY < 0 || botY <= topY) return null;
    // Reject if the span is implausibly small (likely a stray dot).
    if ((botY - topY) < bboxH * 0.20) return null;
    const topX = topXSum / topCount;
    const botX = botXSum / botCount;
    const confidence = clamp01(0.30 + Math.min(0.45, (botY - topY) / Math.max(1, bboxH)));
    return {
      top: { x: topX / w, y: topY / h },
      bottom: { x: botX / w, y: botY / h },
      confidence,
    };
  }

  // Back-panel HEIGHT (POM 13) the way a TD measures it: a vertical drop from the
  // shoulder strap's JOINING point (where the strap meets the panel's top edge)
  // down to the bottom band. This is NOT findBackPanelEdges, which measures an
  // interior seam column's ink extent and lands its top up on the strap/hardware.
  // Key idea: the panel's top edge is the back chest row, and ABOVE that row the
  // only ink in the inner-left column is the shoulder strap — so the strap's x is
  // just the centroid of that ink. The join sits at (strapX, chestRow); the
  // bottom is the band edge straight below it, so the result is a true vertical
  // height that bottoms out on the solid band (see snapBandToSolidEdge).
  function findBackPanelHeight(dark, w, h, bounds, bandYpx, chestRowPx) {
    const { minX, minY, maxX, maxY } = bounds;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;
    if (!(chestRowPx > minY + bh * 0.05 && chestRowPx < maxY)) return null;
    // Inner-left strap zone (the left strap; the right strap sits past 0.42·bw).
    const xLo = minX + Math.round(bw * 0.04);
    const xHi = minX + Math.round(bw * 0.42);
    if (xHi <= xLo) return null;
    let sum = 0, cnt = 0;
    for (let y = minY; y <= chestRowPx; y += 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) if (dark[base + x]) { sum += x; cnt += 1; }
    }
    // Require real strap ink, else let the caller fall back.
    if (cnt < Math.max(8, Math.round(bh * 0.05))) return null;
    const strapX = sum / cnt;
    const yBot = (bandYpx != null && bandYpx > chestRowPx && bandYpx <= maxY) ? bandYpx : maxY;
    const confidence = clamp01(0.35 + Math.min(0.45, cnt / Math.max(1, bw * bh * 0.02)));
    return {
      top:    { x: strapX / w, y: chestRowPx / h },
      bottom: { x: strapX / w, y: yBot / h },
      confidence,
    };
  }

  // When the connected-component grouping returns ONE bbox that spans a wide
  // chunk of the canvas, the most common reason is that two technical-sketch
  // views (front + back) got merged because stray ink (background texture,
  // lace mesh) connects them through the gap. Detect such a "merged" view by
  // looking for a low-density vertical alley in its middle and, if found,
  // split it into [leftSub, rightSub]. Returns [view] unchanged when no
  // confident alley is detected.
  // Compute every back-view landmark from a back view box (pixel-space
  // {minX,minY,maxX,maxY}) against the ink mask. Extracted verbatim from
  // detectLandmarks so the SAME pass can re-run when the TD reassigns the back
  // role in the view-role dialog (redetectBackLandmarks). Returns null-valued
  // fields when backBox is null.
  function detectBackLandmarks(dark, w, h, backBox) {
    if (!backBox) {
      return {
        backInfo: null, backFeatures: null, backPanelInfo: null, backPanelHeightInfo: null,
        backStrapTopInfo: null, backStrapInnerInfo: null, backSideTopInfo: null,
        backSideBottomInfo: null, backSideInfo: null,
      };
    }
    const backInfo = findBackCenterLandmarks(dark, w, h, backBox);
    // Per-view feature pass: the back view's OWN axis, chest/band rows, side
    // seams, and ink endpoints so back anchors snap to ink, not box ratios.
    const backFeatures = detectFeaturesInViewBox(dark, w, h, backBox);
    // Back-panel top/bottom (POM 13) from contour-following near the left edge.
    const backPanelInfo = findBackPanelEdges(dark, w, h, backBox);
    // POM 13 back-panel height: strap-joining point → bottom band (vertical).
    const backPanelHeightInfo = backFeatures
      ? findBackPanelHeight(
          dark, w, h, backBox,
          backFeatures.bandY  != null ? Math.round(backFeatures.bandY  * h) : -1,
          backFeatures.chestY != null ? Math.round(backFeatures.chestY * h) : -1
        )
      : null;
    // Back-view strap-top: topmost ink in the back's left strap zone (POM 14 back).
    const backStrapTopInfo = findBackStrapTopFromInk(
      dark, w, h, backBox,
      backFeatures && backFeatures.chestY != null ? Math.round(backFeatures.chestY * h) : -1
    );
    // Back-view strap INNER edges (POM 15) where each strap meets the back band.
    const backStrapInnerInfo = findBackStrapInnerEdges(
      dark, w, h, backBox,
      backFeatures && backFeatures.chestY != null ? Math.round(backFeatures.chestY * h) : -1,
      backFeatures && backFeatures.axisX  != null ? Math.round(backFeatures.axisX  * w) : -1
    );
    // Back-view side-top (POM 11): topmost ink at the left-edge column.
    const backSideTopInfo = findSideTopFromInk(dark, w, h, backBox, backBox.minX + 1, -1, -1);
    const backSideBottomInfo = backSideTopInfo
      ? findSideBottomFromInk(dark, w, h, backBox, backSideTopInfo.point)
      : null;
    // Preferred POM-11 source: the outer-silhouette seam (top=armpit, bottom=hem).
    const backSideInfo = findBackSideSeam(
      dark, w, h, backBox,
      backFeatures && backFeatures.bandY != null ? Math.round(backFeatures.bandY * h) : -1
    );
    return {
      backInfo, backFeatures, backPanelInfo, backPanelHeightInfo,
      backStrapTopInfo, backStrapInnerInfo, backSideTopInfo, backSideBottomInfo, backSideInfo,
    };
  }

  // Re-run back-view landmark detection against the CURRENT detection.backViewIndex
  // and overwrite the back-* fields, so a TD role correction (back moved to a
  // different panel) re-places the back POMs (11/12/13/15) on the new panel. Uses
  // the retained ink mask (detection.inkMask, dimensions inkMaskW/H). No-op when
  // the mask or a back box is unavailable. Mirrors the field mapping in
  // detectLandmarks' detection assembly.
  function redetectBackLandmarks(detection) {
    if (!detection || !detection.inkMask || !detection.inkMaskW || !detection.inkMaskH) return;
    const views = detection.views || detection.viewBoxes || [];
    const idx = detection.backViewIndex;
    const vb = (Number.isFinite(idx) && idx >= 0) ? views[idx] : null;
    if (!vb || !(vb.width > 0) || !(vb.height > 0)) return;
    const mw = detection.inkMaskW;
    const mh = detection.inkMaskH;
    const backBox = {
      minX: Math.max(0, Math.round(vb.x * mw)),
      minY: Math.max(0, Math.round(vb.y * mh)),
      maxX: Math.min(mw - 1, Math.round((vb.x + vb.width) * mw)),
      maxY: Math.min(mh - 1, Math.round((vb.y + vb.height) * mh)),
      count: 0,
    };
    const bl = detectBackLandmarks(detection.inkMask, mw, mh, backBox);
    detection.back = bl.backInfo;
    detection.backFeatures = bl.backFeatures;
    detection.backPanel = bl.backPanelInfo;
    detection.backPanelHeight = bl.backPanelHeightInfo;
    detection.backStrapInner = bl.backStrapInnerInfo;
    detection.backStrapTop = bl.backStrapTopInfo ? bl.backStrapTopInfo.point : null;
    detection.backSideTop = bl.backSideTopInfo ? bl.backSideTopInfo.point : null;
    detection.backSideBottom = bl.backSideBottomInfo ? bl.backSideBottomInfo.point : null;
    detection.backSide = bl.backSideInfo;
  }
