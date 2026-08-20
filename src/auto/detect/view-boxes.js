// Geometry of the SHEET, not of one landmark: how many garment views are drawn
// on this board, where each one's box is, and which is front_outer / back /
// front_inner. Holds view-box grouping (detectSketchViewBoxes), the primary-view
// pick, the over-wide-box vertical-valley split, and the role classifier plus its
// layout scorer.
//
// It also holds the shared row/column ink-scan primitives (row spans, longest
// row run, band-edge snapping, column counts, the directional ink-bound walks and
// the per-column hem row) that both the geometry stage and the individual
// landmark finders reuse.
//
// Depends on math-utils.js (refineAxisBySymmetry, computeSymmetryScore).
// Source part for app.js. Run `npm run build` after editing.

  function detectSketchViewBoxes(components, fallbackStats, w, h) {
    if (!components || !components.length) {
      return fallbackStats && fallbackStats.maxX >= 0 ? [statsToBounds(fallbackStats)] : [];
    }
    const largest = components.reduce((m, c) => Math.max(m, c.count), 0);
    const minCount = Math.max(8, largest * 0.04);
    const candidates = components
      .filter(c => c.count >= minCount || c.area >= w * h * 0.002)
      .sort((a, b) => a.minX - b.minX);
    if (!candidates.length) return [statsToBounds(fallbackStats)];

    const groups = [];
    for (const c of candidates) {
      const last = groups[groups.length - 1];
      if (!last) {
        groups.push({ minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, count: c.count });
        continue;
      }
      const gap = c.minX - last.maxX;
      const lastW = Math.max(1, last.maxX - last.minX + 1);
      const cW = Math.max(1, c.maxX - c.minX + 1);
      const yOverlap = Math.max(0, Math.min(last.maxY, c.maxY) - Math.max(last.minY, c.minY) + 1);
      const yOverlapRatio = yOverlap / Math.max(1, Math.min(last.maxY - last.minY + 1, c.maxY - c.minY + 1));
      const allowedGap = Math.max(10, Math.min(lastW, cW) * 0.28, w * 0.035);
      const alignedCloseGap = gap <= Math.max(allowedGap, w * 0.08) && yOverlapRatio > 0.55;
      if (gap <= allowedGap || alignedCloseGap) {
        last.minX = Math.min(last.minX, c.minX);
        last.minY = Math.min(last.minY, c.minY);
        last.maxX = Math.max(last.maxX, c.maxX);
        last.maxY = Math.max(last.maxY, c.maxY);
        last.count += c.count;
      } else {
        groups.push({ minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, count: c.count });
      }
    }
    return groups;
  }

  function choosePrimaryViewBox(viewBoxes, dark, w, h) {
    if (!viewBoxes || !viewBoxes.length) return -1;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < viewBoxes.length; i += 1) {
      const b = viewBoxes[i];
      const width = Math.max(1, b.maxX - b.minX + 1);
      const height = Math.max(1, b.maxY - b.minY + 1);
      const centroid = (b.minX + b.maxX) / 2;
      const axis = refineAxisBySymmetry(dark, w, b.minX, b.maxX, b.minY, b.maxY, centroid);
      const sym = computeSymmetryScore(dark, w, axis, b.minX, b.maxX, b.minY, b.maxY);
      const center = (b.minX + b.maxX) / 2 / w;
      const centerBonus = 1 - Math.min(1, Math.abs(center - 0.5) * 1.4);
      const shapeBonus = Math.min(1, height / Math.max(1, width)) * 0.18;
      const score = (b.count || 1) * (0.62 + sym * 0.55 + centerBonus * 0.10 + shapeBonus);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  // Split every view box wide enough to plausibly hold more than one panel at
  // its internal vertical alley, recursing so a board whose panels merged in
  // component-grouping separates into one box per panel. This generalizes the
  // former lone-box-only special case: a box is split-eligible when it spans
  // more than half the canvas (>0.50w). A single garment panel on a multi-panel
  // board is never that wide — there would be no room for the others — so a box
  // over that gate is a merge of >=2 panels (e.g. EvelynBliss's back+inner
  // grouped into one 0.565w box). Correct 2-panel boards keep two sub-half
  // boxes and are untouched, which is why golden is unaffected. The per-box
  // sanity gates inside splitMergedViewByVerticalValley (empty-alley run length
  // + >=20% ink share each side) additionally reject splitting a genuine single
  // view (deep-V neckline, wide back panel).
  function splitWideViewBoxes(boxes, dark, w, h) {
    if (!boxes || boxes.length === 0) return boxes;
    const out = [];
    for (const box of boxes) {
      const parts = splitMergedViewByVerticalValley(dark, w, h, box, 0.50);
      if (parts.length > 1) {
        // Recurse at the SAME 0.50 gate so a box holding 3+ merged panels keeps
        // splitting while any resulting piece still spans more than half the
        // canvas. The gate stays at 0.50 (never lower) because a lone wide
        // single panel — demo1/demo2 group into one >0.50w box that the split
        // separates into front+back — must not have its halves re-split; a
        // lower gate over-splits those legitimate single panels (golden regress).
        out.push(...splitWideViewBoxes(parts, dark, w, h));
      } else {
        out.push(box);
      }
    }
    return out;
  }

  function splitMergedViewByVerticalValley(dark, w, h, view, minWidthRatio = 0.50) {
    const { minX, minY, maxX, maxY } = view;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // Require a fairly wide bbox before we even try to split — narrow boxes
    // are almost certainly a single view that just happens to be off-center.
    if (bw < w * minWidthRatio || bh < 16) return [view];

    // Column density restricted to the view's bbox.
    const colDark = new Uint32Array(bw);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) colDark[x - minX] += 1;
      }
    }
    // Walk the center 30..70% range, looking for the LONGEST run of columns
    // whose density is below 8% of the bbox height (i.e. nearly empty).
    const lo = Math.floor(bw * 0.30);
    const hi = Math.floor(bw * 0.70);
    const emptyThreshold = Math.max(1, Math.round(bh * 0.08));
    let bestStart = -1, bestEnd = -1, bestLen = 0;
    let curStart = -1;
    for (let i = lo; i <= hi; i += 1) {
      if (colDark[i] <= emptyThreshold) {
        if (curStart < 0) curStart = i;
        // Track true run length (end - start + 1); the old `end - start`
        // comparison against a -1/-1 sentinel could never record a 1-col run.
        const curLen = i - curStart + 1;
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
          bestEnd = i;
        }
      } else {
        curStart = -1;
      }
    }
    const runLen = bestLen;
    // Need a noticeable alley — at least 4% of the bbox width — before splitting.
    if (bestStart < 0 || runLen < Math.max(4, bw * 0.04)) return [view];

    // Use the MIDDLE of the alley as the split point. Recompute each sub-view's
    // ink-bbox by scanning its columns; this snaps the bbox to the actual ink
    // (so the FRONT/BACK overlay doesn't include the gap or stray ink).
    const splitX = minX + Math.round((bestStart + bestEnd) / 2);
    const subBounds = (xStart, xEnd) => {
      let lMinX = w, lMaxX = -1, lMinY = h, lMaxY = -1, lCount = 0;
      for (let y = minY; y <= maxY; y += 1) {
        const base = y * w;
        for (let x = xStart; x <= xEnd; x += 1) {
          if (!dark[base + x]) continue;
          lCount += 1;
          if (x < lMinX) lMinX = x;
          if (x > lMaxX) lMaxX = x;
          if (y < lMinY) lMinY = y;
          if (y > lMaxY) lMaxY = y;
        }
      }
      return lMaxX < 0 ? null : { minX: lMinX, minY: lMinY, maxX: lMaxX, maxY: lMaxY, count: lCount };
    };
    const left = subBounds(minX, splitX - 1);
    const right = subBounds(splitX + 1, maxX);
    if (!left || !right) return [view];
    // Sanity check the split: each side should hold a non-trivial share of
    // the original ink. Otherwise the alley was probably just a real empty
    // space inside a single view (e.g. a deep V neckline).
    const total = Math.max(1, view.count || (left.count + right.count));
    const minShare = 0.20;
    if (left.count / total < minShare || right.count / total < minShare) return [view];
    return [left, right];
  }

  // Decide each detected garment component's semantic role. Visual features
  // get first vote; layout only breaks ties. This keeps two-view styles
  // working while allowing a third inner-cup/front-lining detail view.
  function classifySketchViewRoles(dark, w, h, viewBoxes) {
    const scores = (viewBoxes || []).map((view) => scoreViewLayout(view, w, dark, h));
    const roles = new Array(scores.length).fill('unknown');
    if (!viewBoxes || !viewBoxes.length) {
      return {
        roles,
        frontOuterIndex: -1,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: true,
      };
    }
    if (viewBoxes.length === 1) {
      roles[0] = 'front_outer';
      scores[0].roleConfidence = 0.55;
      return {
        roles,
        frontOuterIndex: 0,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: false,
      };
    }

    const largest = viewBoxes.reduce((m, v) => Math.max(m, v.count || 0), 0);
    const minQualifyingCount = Math.max(1, largest * 0.05);
    const eligible = viewBoxes
      .map((view, index) => ({ view, index, score: scores[index] }))
      .filter((item) => (item.view.count || 0) >= minQualifyingCount);
    if (!eligible.length) {
      roles[0] = 'front_outer';
      scores[0].roleConfidence = 0.35;
      return {
        roles,
        frontOuterIndex: 0,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: true,
      };
    }

    const assignBest = (role, metric, exclude) => {
      let best = null;
      for (const item of eligible) {
        if (exclude && exclude.has(item.index)) continue;
        if (!best || item.score[metric] > best.score[metric]) best = item;
      }
      if (!best) return -1;
      roles[best.index] = role;
      return best.index;
    };

    const used = new Set();
    let backIndex = -1;
    let frontInnerIndex = -1;
    let frontOuterIndex = -1;

    if (eligible.length >= 3) {
      // Panel order on a technical board is a fixed TD convention, left to
      // right: front_outer, back, front_inner. Position is a far more reliable
      // signal than the visual scores — a symmetric racerback back and a
      // molded-cup inner cutaway score too alike to tell apart — so assign the
      // three roles by centroidX order. Take the three highest-ink eligible
      // views first so a stray 4th blob can't shift the mapping; any extra
      // panel stays 'unknown' and trips reviewRequired below.
      const trio = eligible
        .slice()
        .sort((a, b) => (b.view.count || 0) - (a.view.count || 0))
        .slice(0, 3)
        .sort((a, b) => a.score.centroidX - b.score.centroidX);
      frontOuterIndex = trio[0].index; roles[frontOuterIndex] = 'front_outer';
      backIndex       = trio[1].index; roles[backIndex] = 'back';
      frontInnerIndex = trio[2].index; roles[frontInnerIndex] = 'front_inner';
      used.add(frontOuterIndex); used.add(backIndex); used.add(frontInnerIndex);
      // Position is authoritative for the 3-view layout, so assign a confident
      // role score — the review dialog is NOT forced on a clean 3-panel board
      // (the TD can still nudge anchors if a board ever breaks the convention).
      for (const idx of [frontOuterIndex, backIndex, frontInnerIndex]) {
        if (scores[idx]) scores[idx].roleConfidence = 0.75;
      }
    } else {
      // Two panels (the common front + back board): back by best backScore, the
      // remaining view is front_outer. Unchanged from the long-standing path.
      backIndex = assignBest('back', 'backScore', used);
      if (backIndex >= 0) used.add(backIndex);

      frontOuterIndex = assignBest('front_outer', 'frontOuterScore', used);
      if (frontOuterIndex < 0) {
        const fallback = eligible
          .filter(item => !used.has(item.index))
          .sort((a, b) => a.score.centroidX - b.score.centroidX)[0] || eligible[0];
        frontOuterIndex = fallback.index;
        roles[frontOuterIndex] = 'front_outer';
      }
    }

    const roleConfidence = (index, metric) => {
      if (index < 0 || !scores[index]) return 0;
      const values = eligible
        .filter(item => item.index !== index)
        .map(item => item.score[metric])
        .sort((a, b) => b - a);
      const runnerUp = values.length ? values[0] : 0;
      return clamp01(0.45 + (scores[index][metric] - runnerUp) * 0.55);
    };
    // The ≤2-panel path derives confidence from the visual score margin. The
    // 3-view path already set a fixed positional confidence above (position is
    // authoritative there), so it is not recomputed from scores here.
    if (eligible.length < 3) {
      if (frontOuterIndex >= 0) scores[frontOuterIndex].roleConfidence = roleConfidence(frontOuterIndex, 'frontOuterScore');
      if (backIndex >= 0) scores[backIndex].roleConfidence = roleConfidence(backIndex, 'backScore');
    }

    const reviewRequired =
      eligible.length > 3 ||
      eligible.some(item => roles[item.index] === 'unknown') ||
      eligible.some(item => {
        const role = roles[item.index];
        if (role === 'front_outer') return (scores[item.index].roleConfidence || 0) < 0.52;
        if (role === 'front_inner') return (scores[item.index].roleConfidence || 0) < 0.52;
        if (role === 'back') return (scores[item.index].roleConfidence || 0) < 0.52;
        return true;
      });

    return { roles, frontOuterIndex, backIndex, frontInnerIndex, scores, reviewRequired };
  }

  function scoreViewLayout(view, w, dark, h) {
    const bw = (view.maxX - view.minX + 1);
    const bh = (view.maxY - view.minY + 1);
    const cx = (view.minX + view.maxX) / 2;
    const ink = view.count || 1;
    let edgeInk = 0;
    let centerVerticalInk = 0;
    if (dark && w && h && bw > 0 && bh > 0) {
      const insetX = Math.max(2, Math.round(bw * 0.16));
      const insetY = Math.max(2, Math.round(bh * 0.12));
      const centerLo = Math.round(view.minX + bw * 0.42);
      const centerHi = Math.round(view.minX + bw * 0.58);
      for (let y = view.minY; y <= view.maxY; y += 1) {
        const base = y * w;
        for (let x = view.minX; x <= view.maxX; x += 1) {
          if (!dark[base + x]) continue;
          const inInner = x >= view.minX + insetX && x <= view.maxX - insetX
            && y >= view.minY + insetY && y <= view.maxY - insetY;
          if (!inInner) edgeInk += 1;
          if (x >= centerLo && x <= centerHi) centerVerticalInk += 1;
        }
      }
    }
    const widthRatio = w > 0 ? bw / w : 0;
    const aspect = bh / Math.max(1, bw);
    const edgeRatio = edgeInk / ink;
    const centerVerticalRatio = centerVerticalInk / ink;
    const leftness = 1 - clamp01(cx / Math.max(1, w));
    const rightness = clamp01(cx / Math.max(1, w));
    const symmetry = computeSymmetryScore(
      dark,
      w,
      Math.round(cx),
      view.minX,
      view.maxX,
      view.minY,
      view.maxY
    );
    const frontOuterScore =
      symmetry * 0.34 +
      widthRatio * 0.22 +
      edgeRatio * 0.16 +
      leftness * 0.14 +
      (1 - clamp01(Math.abs(aspect - 1.05))) * 0.14;
    const backScore =
      rightness * 0.30 +
      centerVerticalRatio * 0.24 +
      edgeRatio * 0.20 +
      clamp01(aspect / 1.45) * 0.16 +
      (1 - symmetry) * 0.10;
    return {
      centroidX: w > 0 ? cx / w : 0,
      widthRatio,
      count: view.count || 0,
      edgeRatio,
      centerVerticalRatio,
      symmetry,
      frontOuterScore,
      backScore,
      roleConfidence: 0,
    };
  }

  function computeRowSpans(mask, w, minX, maxX, minY, maxY) {
    const spans = new Uint32Array(maxY + 1);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let left = -1, right = -1;
      for (let x = minX; x <= maxX; x += 1) {
        if (!mask[base + x]) continue;
        if (left < 0) left = x;
        right = x;
      }
      spans[y] = left >= 0 ? right - left + 1 : 0;
    }
    return spans;
  }

  // Longest contiguous dark run per row. Solid seam lines have a long single
  // run; dense lace patterns have many short runs at high total density. This
  // is the signal that lets the underbust-seam detector beat the lace band.
  function computeRowMaxRun(mask, w, minX, maxX, minY, maxY) {
    const runs = new Uint32Array(maxY + 1);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let cur = 0, best = 0;
      for (let x = minX; x <= maxX; x += 1) {
        if (mask[base + x]) {
          cur += 1;
          if (cur > best) best = cur;
        } else {
          cur = 0;
        }
      }
      runs[y] = best;
    }
    return runs;
  }

  // Snap a detected band row to the SOLID bottom edge of the band, not a zig-zag
  // elastic line drawn above it. Scanned row by row, a zig-zag has only short
  // horizontal runs (its diagonal strokes crossing each row), while the solid
  // edge is one long continuous run. We search a tight window around the detected
  // band zone and take the LOWEST row that reads as solid, so the bottom-band and
  // center-front-bottom anchors land on the real edge under any decorative
  // stitching. Returns the original row when no solid line stands out (e.g. a
  // band drawn only as a zig-zag), so non-banded sketches are untouched.
  function snapBandToSolidEdge(rowRun, bandRow, minY, maxY, bandWidth, bandHeight) {
    if (bandRow <= 0) return bandRow;
    const lo = Math.max(minY, bandRow - Math.round(bandHeight * 0.04));
    const hi = Math.min(maxY, bandRow + Math.round(bandHeight * 0.12));
    let peakRun = 0;
    for (let y = lo; y <= hi; y += 1) if (rowRun[y] > peakRun) peakRun = rowRun[y];
    if (peakRun < bandWidth * 0.30) return bandRow;
    const solidThresh = Math.max(bandWidth * 0.30, peakRun * 0.6);
    for (let y = hi; y >= lo; y -= 1) if (rowRun[y] >= solidThresh) return y;
    return bandRow;
  }

  function countDarkByColumnInRange(mask, w, minX, maxX, minY, maxY) {
    const counts = new Uint32Array(w);
    const y0 = Math.max(0, minY);
    const y1 = Math.max(y0, maxY);
    for (let y = y0; y <= y1; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (mask[base + x]) counts[x] += 1;
      }
    }
    return counts;
  }

  // Walk inward along a horizontal band of rows and return the first column
  // where ink appears. Used to snap chest-left/right (and band-left/right) to
  // the actual ink endpoints instead of view-box edges. halfBand widens the
  // search vertically so a slightly-off chest row still finds the line.
  function findHorizontalInkBound(dark, w, rowCenter, halfBand, fromX, toX, direction) {
    const yLo = Math.max(0, rowCenter - halfBand);
    const yHi = rowCenter + halfBand;
    if (direction > 0) {
      for (let x = fromX; x <= toX; x += 1) {
        for (let y = yLo; y <= yHi; y += 1) {
          if (dark[y * w + x]) return x;
        }
      }
    } else {
      for (let x = fromX; x >= toX; x -= 1) {
        for (let y = yLo; y <= yHi; y += 1) {
          if (dark[y * w + x]) return x;
        }
      }
    }
    return -1;
  }

  // Walk vertically along a thin column-band and return the first row with
  // ink. Used to snap CF-top to where the cleavage actually begins instead of
  // a hardcoded 4% offset from the view-box top.
  function findVerticalInkBound(dark, w, colCenter, halfBand, fromY, toY, direction) {
    const xLo = Math.max(0, colCenter - halfBand);
    const xHi = colCenter + halfBand;
    if (direction > 0) {
      for (let y = fromY; y <= toY; y += 1) {
        const base = y * w;
        for (let x = xLo; x <= xHi; x += 1) {
          if (dark[base + x]) return y;
        }
      }
    } else {
      for (let y = fromY; y >= toY; y -= 1) {
        const base = y * w;
        for (let x = xLo; x <= xHi; x += 1) {
          if (dark[base + x]) return y;
        }
      }
    }
    return -1;
  }

  // Lowest inked row in a thin column band — the garment's drawn hem AT ONE x.
  //
  // bandY is a single horizontal row, which is right for a straight hem and
  // wrong for a scalloped or arched one. Measured on Evelyn vA 3.0 (1830x711):
  // the picot hem sits at 662px out at the sides and rises to 632px at centre
  // front, a 30px arch, while bandY is a flat 659px — so the CF bottom anchor
  // ends up 27px BELOW the artwork, floating in white space.
  //
  // Used ONLY by the POM 6 / POM 7 bottom anchors (US-061). band-left and
  // band-right deliberately keep the flat row so POM 1 stays a level span.
  //
  // Scans UP from just below the band row and returns the first inked row.
  // Returns null when the window holds no ink, so the caller keeps bandY and
  // straight-hem sketches stay byte-identical.
  function hemRowAtColumn(dark, w, h, colPx, bandRowPx, bboxH) {
    if (!Number.isFinite(colPx) || !Number.isFinite(bandRowPx) || !(bboxH > 0)) return null;
    const halfBand = Math.max(1, Math.round(bboxH * 0.006));
    const fromY = Math.min(h - 1, Math.round(bandRowPx + bboxH * 0.06));
    const toY = Math.max(0, Math.round(bandRowPx - bboxH * 0.12));
    if (fromY < toY) return null;
    const hit = findVerticalInkBound(dark, w, Math.round(colPx), halfBand, fromY, toY, -1);
    return hit >= 0 ? hit : null;
  }
