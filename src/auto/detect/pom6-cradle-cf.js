// POM 6 — the cradle/cup-bottom seam at CENTER FRONT (the cradle-cf-top
// landmark, POM 6's top endpoint). One function, findCradleCfTop(ctx), holding
// all three acceptance tiers: the direct axis-ink path (with its front-closure
// placket snap), the CF-gore dip projection, and the interrupted-placket
// junction tier (US-015 / ADR 0023).
//
// Pure: it reads only the pixel context handed to it and returns every value the
// landmark stage needs. Its caller is src/auto/detect/landmark-stage.js; the
// sibling POM 7 seam detector is src/auto/detect/pom7-cradle-cup.js.
// Source part for app.js. Run `npm run build` after editing.

  // Detect POM 6's cradle-at-CF top endpoint. `ctx` carries the pixel-space
  // facts the block below reads by name (masks, bbox, axis, row picks and their
  // strengths); every value it decides is returned, nothing is mutated outside.
  function findCradleCfTop(ctx) {
    const {
      dark, rawDark, w, h,
      minX, minY, maxX, maxY, bboxW, bboxH,
      axisPx, axisXpx,
      rowNoiseFloor, peakSep,
      bandRow, bandEdgeRow,
      chestRow, underbustRow,
      cradleRow, cradleStrength,
      cfTopPx,
    } = ctx;

    // ---- Cradle-at-CF (POM 6 top endpoint) ----
    // POM 6 measures the cradle / cup-bottom seam height at center front. Per
    // rule.md POM 6 Contract, the start point must come from REAL cradle /
    // cup-bottom seam evidence (not "any ink near cradleRow × axis"). The same
    // Medium evidence pattern from POM 7 §3 applies: clear cradle seam at the
    // axis plus a clean baseline projection beneath it.
    //
    // The CF vertical line trivially inks the column from cf-top to cf-bottom,
    // so a column-ratio / dashed-guide check (POM 7 patterns 1 & 2) would
    // always trip here and give zero discrimination. We instead measure the
    // HORIZONTAL run of the cradle seam across the CF axis — the cradle/
    // cup-bottom seam approaches CF as a horizontal seam extending ~15%+ of
    // bboxW. A decorative tick, a stray ink crossing, or the CF vertical line
    // itself contributes only 1-2 inked columns in this scan.
    //
    // Guards:
    //   - cradleY detected (cradleStrength > rowNoiseFloor * 1.3)
    //   - bandRow detected (POM 6 end must project onto a real baseline)
    //   - row sits strictly below chest/underbust and above band
    //   - row sits well below cf-top so the seam is plausibly a cradle, not a
    //     decorative neckline tick (rule.md: "start is actually CF top, …")
    //   - cradle-row ink inside a small window straddling axisX (seed sanity)
    //   - HORIZONTAL seam continuity at cradleRow ± 1 around axisPx ≥ threshold
    //   - band-row ink at axisPx (baseline projection)
    // When any guard fails the anchor is NOT seeded and POM 6 is forced to
    // REVIEW_ONLY downstream — no ratio fallback.
    let cradleCfTop = null;
    let cradleCfTopInkRatio = 0;
    let cradleCfTopBandInkRatio = 0;
    let cradleCfTopSeamHorizontalRun = 0;
    let cradleCfTopSeamSingleRowRun = 0;
    let cradleCfTopReject = null;
    // True when cradle-cf-top was accepted via the CF-gore dip path (seam
    // crosses CF but the exact axis cell is empty). Downstream tagging drops
    // this anchor to low confidence + reviewRequired.
    let cradleCfTopDipProjected = false;
    // Nearest inked seam column (gap in px) to the CF axis on each side, from
    // the horizontal-continuity scan. -1 when no inked column on that side.
    let cradleCfSeamLeftReachPx = -1;
    let cradleCfSeamRightReachPx = -1;
    if (cradleRow < 0 || cradleStrength <= rowNoiseFloor * 1.3) {
      cradleCfTopReject = 'no cradle row detected';
    } else if (bandRow < 0) {
      cradleCfTopReject = 'no band row detected (POM 6 end cannot be projected)';
    } else {
      const chestGuardRow = chestRow > 0 ? chestRow : (underbustRow > 0 ? underbustRow : -1);
      const aboveBand = cradleRow <= bandRow - peakSep;
      const belowChest = chestGuardRow > 0 ? cradleRow >= chestGuardRow + peakSep : true;
      const cfTopGuardPx = Math.max(peakSep * 2, Math.round(bboxH * 0.15));
      const farFromCfTop = cfTopPx >= 0 ? (cradleRow - cfTopPx) >= cfTopGuardPx : true;
      if (!aboveBand) cradleCfTopReject = 'cradle row too close to band';
      else if (!belowChest) cradleCfTopReject = 'cradle row too close to chest';
      else if (!farFromCfTop) cradleCfTopReject = 'cradle row too close to CF top';
      else {
        const ySpan = 2;
        const xSpan = Math.max(6, Math.round(bboxW * 0.06));
        const yLo = Math.max(0, cradleRow - ySpan);
        const yHi = Math.min(h - 1, cradleRow + ySpan);
        const xLo = Math.max(0, axisPx - xSpan);
        const xHi = Math.min(w - 1, axisPx + xSpan);
        let ink = 0;
        let win = 0;
        for (let y = yLo; y <= yHi; y += 1) {
          for (let x = xLo; x <= xHi; x += 1) {
            win += 1;
            if (dark[y * w + x]) ink += 1;
          }
        }
        cradleCfTopInkRatio = win > 0 ? ink / win : 0;

        // Baseline projection: require band-row ink at the CF axis.
        const yBandSpan = Math.max(2, Math.round(bboxH * 0.012));
        const yBandLo = Math.max(0, bandRow - yBandSpan);
        const yBandHi = Math.min(h - 1, bandRow + yBandSpan);
        let bandInk = 0, bandWin = 0;
        for (let y = yBandLo; y <= yBandHi; y += 1) {
          for (let x = xLo; x <= xHi; x += 1) {
            bandWin += 1;
            if (dark[y * w + x]) bandInk += 1;
          }
        }
        cradleCfTopBandInkRatio = bandWin > 0 ? bandInk / bandWin : 0;

        // Horizontal cradle-seam continuity around the CF axis. Measure the
        // longest run of inked columns at cradleRow ± 1 (3-row band tolerates
        // anti-aliasing) AND at the exact cradleRow inside a wide window. A
        // real cradle seam crosses CF for 15-40% of bboxW; a cup-outline
        // tangent, decorative tick, or the CF vertical line all contribute
        // only a handful of columns. Use the RAW mask so dashed/light seam
        // ink isn't filtered out by the component-size floor.
        const runWin = Math.max(20, Math.round(bboxW * 0.22));
        const runLo = Math.max(0, axisPx - runWin);
        const runHi = Math.min(w - 1, axisPx + runWin);
        const runYLo = Math.max(0, cradleRow - 1);
        const runYHi = Math.min(h - 1, cradleRow + 1);
        // Axis-bridging evidence for the CF-gore dip case. A real cradle /
        // underwire seam approaches CF from BOTH sides and only breaks inside
        // the narrow center-front gore (where the two cups meet and no seam
        // ink is drawn). We record how close the seam's inked columns come to
        // the CF axis from the left and from the right. When the seam brackets
        // the axis with only a small gore gap on each side, the seam clearly
        // crosses CF even though the exact axis window reads empty. A seam that
        // lives entirely on one side (a cup-bottom arm, a stray tick) reaches
        // the axis from at most one direction and is NOT bridging. These two
        // reach counters are declared in the outer scope above.
        //
        // Build the per-column inked-band map ONCE (raw 3-row band), then derive
        // every piece of evidence from it. D6: derive the reaches from a column
        // that belongs to a SOLID run (≥ minReachRun contiguous inked columns),
        // not the nearest lone inked pixel — a single anti-aliased pixel near the
        // gore otherwise shifts a reach by 1px and can flip symmetricReach
        // run-to-run. The min-run is the hysteresis. Horizontal-run and
        // single-row-run discriminators are unchanged.
        const colCount = runHi - runLo + 1;
        const bandInked = new Array(Math.max(0, colCount)).fill(false);
        for (let xi = 0; xi < colCount; xi += 1) {
          const x = runLo + xi;
          for (let y = runYLo; y <= runYHi; y += 1) {
            if (rawDark[y * w + x]) { bandInked[xi] = true; break; }
          }
        }
        // Longest contiguous inked run in the 3-row band.
        let currentRun = 0;
        for (let xi = 0; xi < colCount; xi += 1) {
          if (bandInked[xi]) {
            currentRun += 1;
            if (currentRun > cradleCfTopSeamHorizontalRun) cradleCfTopSeamHorizontalRun = currentRun;
          } else {
            currentRun = 0;
          }
        }
        // Longest contiguous inked run at the EXACT cradle row.
        let currentSingle = 0;
        for (let x = runLo; x <= runHi; x += 1) {
          if (rawDark[cradleRow * w + x]) {
            currentSingle += 1;
            if (currentSingle > cradleCfTopSeamSingleRowRun) cradleCfTopSeamSingleRowRun = currentSingle;
          } else {
            currentSingle = 0;
          }
        }
        // Reaches: nearest column to the CF axis that belongs to a solid seam
        // run (≥ minReachRun), scanning each maximal run once it closes. Set to
        // 2 so a single isolated anti-aliased pixel (run length 1) can't define
        // a reach — the run-to-run flip source — while a genuine thin/dashed
        // gore seam (demo7's tuned dip win) still counts.
        const minReachRun = 2;
        let runStart = -1;
        for (let xi = 0; xi <= colCount; xi += 1) {
          const inked = xi < colCount && bandInked[xi];
          if (inked) {
            if (runStart < 0) runStart = xi;
          } else if (runStart >= 0) {
            if (xi - runStart >= minReachRun) {
              for (let k = runStart; k < xi; k += 1) {
                const x = runLo + k;
                if (x <= axisPx) {
                  const gap = axisPx - x;
                  if (cradleCfSeamLeftReachPx < 0 || gap < cradleCfSeamLeftReachPx) cradleCfSeamLeftReachPx = gap;
                }
                if (x >= axisPx) {
                  const gap = x - axisPx;
                  if (cradleCfSeamRightReachPx < 0 || gap < cradleCfSeamRightReachPx) cradleCfSeamRightReachPx = gap;
                }
              }
            }
            runStart = -1;
          }
        }
        // Discriminator thresholds. We need to reject:
        //   - the CF vertical line crossing cradleRow alone (~1-2 inked cols)
        //   - decorative ticks crossing cradleRow (~3-5 inked cols)
        //   - stray sparse noise (~< 6 inked cols)
        // while accepting real cradle seams that may curve at the CF dip
        // (only ~10-15 contiguous inked cols at cradleRow in some styles).
        //
        // Thresholds count inked COLUMNS on the analysis grid. That grid is the
        // fixed 1024 px target ONLY when the source is ≥ 1024 px wide; a smaller
        // upload is analysed at its native width (scale is capped at 1), so the
        // same physical seam spans fewer sample columns. D2: scale the absolute
        // column thresholds by gridScale = w / 1024 so a seam of a given real
        // width clears the same fraction regardless of source resolution — and
        // gridScale is exactly 1 for every ≥ 1024 px source, leaving their
        // detection unchanged. We still do NOT scale by bboxW: seam-ink width is
        // style-dependent, not garment-size-dependent, at a fixed grid.
        //
        // EITHER pathway also accepts: a dense local ink ratio (≥ 0.20) at
        // (axisPx, cradleRow) — the cradle seam IS at the axis cell, even if
        // its horizontal arm is short. BUT require a minimum horizontal
        // extent (≥ 3 inked columns at the exact cradle row) so an isolated
        // decorative blob (bow/nơ centered on the CF axis at the cradle row,
        // typically 1-2 columns wide) cannot pass — rule.md: "start is
        // actually CF top, neckline, or decorative tick" reject reason.
        // Round UP (ceil): rounding a rejection threshold DOWN would let a
        // feature just under the true scaled bar (e.g. a 3-col decorative tick
        // at a 640px grid, where 5*0.625 = 3.125) slip through as a seam. Ceil
        // keeps the discrimination margin on the reject side; at a ≥1024 source
        // gridScale is 1 so these equal the original 8 / 5 / 3.
        const gridScale = w / DETECTION_TARGET_WIDTH;
        const minBandRun = Math.max(3, Math.ceil(8 * gridScale));
        const minSingleRun = Math.max(2, Math.ceil(5 * gridScale));
        const minDenseSingleRun = Math.max(2, Math.ceil(3 * gridScale));
        const seamRunOK = (cradleCfTopSeamHorizontalRun >= minBandRun)
                          || (cradleCfTopSeamSingleRowRun >= minSingleRun);
        const denseLocalInk = cradleCfTopInkRatio >= 0.20
          && cradleCfTopSeamSingleRowRun >= minDenseSingleRun;
        const seamStrong = seamRunOK || denseLocalInk;

        // CF-gore dip: the seam clearly crosses CF (a strong contiguous run
        // that brackets the axis SYMMETRICALLY from both sides) but no ink sits
        // in the exact axis window, because the two cups separate at center
        // front and the seam is not drawn across the narrow gore. This is a
        // real cradle / underwire seam whose CF endpoint we must PROJECT onto
        // the axis rather than reject outright. Empirically (demo3/demo7) the
        // seam retreats from CF by ~9-13% of bbox width on BOTH sides by nearly
        // the SAME amount — the tell-tale of a symmetric gore, as opposed to a
        // one-sided cup-bottom arm (which inks only one side, or reaches the
        // two sides by very different amounts). We accept only under strict
        // guards, and downstream tag the anchor low-confidence + reviewRequired
        // so the TD verifies the projected start:
        //   - the exact axis window is empty (what makes this a "dip", not a
        //     normally-inked seam that the primary path already handles),
        //   - a strong seam RUN exists (reuse the seamRunOK evidence; a long
        //     run, not a stray tick),
        //   - inked seam ink brackets the axis from BOTH sides,
        //   - the two reaches are near-symmetric (|L − R| ≤ symTolPx): a
        //     genuine gore dip retreats evenly; a one-sided arm does not,
        //   - the wider reach is still bounded to the CF zone (≤ maxGorePx =
        //     16% of bbox width — the same scale POM 7 uses to hold its
        //     bottom-cup line OFF the CF axis), so we never re-label a POM 7
        //     bottom-cup arc as a CF seam,
        //   - a baseline projection still requires band-row ink under the axis
        //     (unchanged cradleCfTopBandInkRatio gate) so POM 6's bottom is
        //     never drawn onto an empty baseline (this correctly leaves demo5,
        //     whose CF band ink is zero, as REVIEW_ONLY).
        const symTolPx = Math.max(6, Math.round(bboxW * 0.04));
        const maxGorePx = Math.round(bboxW * 0.16);
        const bothSidesReach = cradleCfSeamLeftReachPx >= 0 && cradleCfSeamRightReachPx >= 0;
        const symmetricReach = bothSidesReach
          && Math.abs(cradleCfSeamLeftReachPx - cradleCfSeamRightReachPx) <= symTolPx;
        const reachBounded = bothSidesReach
          && Math.max(cradleCfSeamLeftReachPx, cradleCfSeamRightReachPx) <= maxGorePx;
        const seamBridgesAxis = seamRunOK && symmetricReach && reachBounded;

        if (cradleCfTopInkRatio < 0.05) {
          // Normal path requires ink at the axis; the dip path is the sole
          // exception, and only when the seam demonstrably crosses CF and a
          // baseline exists to project onto.
          if (seamBridgesAxis && cradleCfTopBandInkRatio >= 0.02) {
            cradleCfTop = { x: axisXpx / w, y: cradleRow / h };
            cradleCfTopDipProjected = true;
          } else {
            cradleCfTopReject = 'no ink support at cradle row near CF axis';
          }
        } else if (!seamStrong) {
          cradleCfTopReject = 'no clear cradle/cup-bottom seam approaching CF axis (weak or ambiguous horizontal seam ink)';
        } else if (cradleCfTopBandInkRatio < 0.02) {
          cradleCfTopReject = 'no baseline ink under CF axis to project POM 6 endpoint';
        } else {
          // Direct accept — but on a front-closure style (zip/hook placket at
          // CF) the ink that satisfied the axis-window test is the PLACKET's
          // own vertical structure, which inks the axis zone at EVERY row, so
          // (axis, cradleRow) can sit below the real cup-seam ↔ CF junction
          // (TD correction 2026-07-10, zip-front sketch: POM 6 starts where
          // the cradle seam MEETS the placket, not at the flat cradle row).
          // Detect a placket — near-continuous vertical ink columns
          // bracketing the axis — and snap y UP to the topmost row where
          // seam ink adjoins the placket from BOTH sides. Classic gores have
          // no such columns and keep the flat-cradle-row behavior unchanged.
          let cfSeamRow = cradleRow;
          {
            const xz = Math.max(4, Math.round(bboxW * 0.06));
            const vTop = Math.max(0, cradleRow - Math.round(bboxH * 0.15));
            const vBot = Math.min(h - 1, bandRow - 2);
            let placketL = -1, placketR = -1;
            if (vBot > vTop + 4) {
              for (let x = Math.max(0, axisPx - xz); x <= Math.min(w - 1, axisPx + xz); x += 1) {
                let inked = 0;
                for (let y = vTop; y <= vBot; y += 1) {
                  if (rawDark[y * w + x]) inked += 1;
                }
                // ≥ 0.85: a placket edge is a continuous drawn LINE. A dotted
                // mesh-gore fill also stacks ink in a column but stays well
                // under this bar, and must not be mistaken for a placket.
                if (inked / (vBot - vTop + 1) >= 0.85) {
                  if (x <= axisPx && (placketL < 0 || x < placketL)) placketL = x;
                  if (x >= axisPx && x > placketR) placketR = x;
                }
              }
            }
            // A real placket (zip/hook/button stand) has WIDTH. A single CF
            // seam line under the gore also reads as a continuous vertical
            // column but is 1-3 px wide — snapping along it would drag POM 6
            // up the gore's converging lace edges (TD-annotated fixture
            // "need TD correction.png" pins the start at the gore bottom).
            const minPlacketW = Math.max(6, Math.round(w * 0.015));
            if (placketL >= 0 && placketR - placketL >= minPlacketW) {
              // Adjacency gap in IMAGE-width terms, not bbox terms: the ink
              // bbox spans BOTH views on two-view sketches, so a bbox-relative
              // gap balloons to ~10px and lets scattered lace-texture dots
              // "adjoin" the placket (same failure class as the B4 seam-pad
              // fix). 0.4% of the analysis width ≈ a real seam-to-placket
              // touch distance.
              const gmax = Math.max(2, Math.round(w * 0.004));
              const jTop = Math.max(0, cradleRow - Math.round(bboxH * 0.12));
              // Two adjacency strengths. FINDING the junction (scanning up
              // from the cradle row) accepts any real ink touch (≥2 px) — a
              // thin dashed cup seam crosses the placket edge with only a
              // couple of pixels per row pair. EXTENDING upward to the seam's
              // top line demands a solid run (≥4 px): sparse lace-texture
              // dots peak at 2-3 and would otherwise form stepping stones
              // that walk the junction up a decorative lace edge.
              const strip = gmax + 4;
              const adjoins = (y, x0, x1, minHits) => {
                let hits = 0;
                for (let y2 = y; y2 <= Math.min(h - 1, y + 1); y2 += 1) {
                  for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x += 1) {
                    if (rawDark[y2 * w + x]) hits += 1;
                  }
                }
                return hits >= minHits;
              };
              const adjoinsBoth = (y, minHits) => adjoins(y, placketL - strip, placketL - 1, minHits)
                && adjoins(y, placketR + 1, placketR + strip, minHits);
              // Scan UP from the cradle row and take the FIRST adjoining seam
              // block — the cradle seam is the structure nearest the cradle
              // row. Taking the topmost adjoining row in the window instead
              // would snap to an unrelated upper junction (a lace neckline
              // edge also adjoins the placket on some styles). Then extend to
              // the seam's TOP ink line: the seam is drawn as paired/dashed
              // stitch lines that adjoin at slightly different rows, so hop
              // small non-adjoining gaps (≤ hop rows, relative to the latest
              // top) — but never far enough to leave the seam block for a
              // distant structure. The TD arrow tip sits on the upper line.
              const hop = Math.max(3, Math.round(bboxH * 0.03));
              for (let y = cradleRow - 2; y >= jTop; y -= 1) {
                if (adjoinsBoth(y, 2)) {
                  let top = y;
                  let probe = y - 1;
                  while (probe >= jTop && (top - probe) <= hop) {
                    if (adjoinsBoth(probe, 4)) top = probe;
                    probe -= 1;
                  }
                  cfSeamRow = top;
                  break;
                }
              }
            }
          }
          cradleCfTop = { x: axisXpx / w, y: cfSeamRow / h };
        }
      }
    }

    // Interrupted-seam junction tier (US-015 / ADR 0023): on front-closure
    // styles the cradle/band seam is interrupted AT the CF axis by the
    // placket, so the direct paths above (which need ink on the winning
    // cradle row at the axis) miss — and on such styles the cradle ROW prior
    // itself can lock onto the neckline far above the true seam (demo4: row
    // 0.54, rejected 'too close to CF top' while the seam sits at 0.83).
    // Recover it row-agnostically: scan rows below cf-top for the junction
    // signature — a long horizontal seam run approaching the axis from BOTH
    // sides, a narrow CF gap roughly centered on the axis, and VERTICAL
    // closure-edge ink bounding the gap (the placket sides; a curved wire
    // bounding a gore gap is locally horizontal and fails this). Topmost
    // qualifying row wins (the seam's upper stitch line — where the TD arrow
    // tip sits, per the amorafit correction). Seeds low-confidence +
    // reviewRequired via the seamJunction provenance; never trusted further.
    let cradleCfTopJunction = false;
    if (!cradleCfTop && cfTopPx >= 0 && bandRow > 0) {
      const jStart = Math.min(h - 1, cfTopPx + Math.max(4, Math.round(bboxH * 0.05)));
      const jEnd = Math.max(jStart, (bandEdgeRow > 0 ? bandEdgeRow : bandRow) - Math.max(3, Math.round(bboxH * 0.02)));
      const minRunPx = Math.max(10, Math.round(bboxW * 0.12));
      const maxGapPx = Math.max(8, Math.round(bboxW * 0.18));
      const maxHole = 1;                                   // tolerate anti-aliased seams
      const vEdgeRun = Math.max(6, Math.round(bboxH * 0.10));
      const inkAt = (x, y) => rawDark[y * w + x];
      for (let y = jStart; y <= jEnd && !cradleCfTopJunction; y += 1) {
        const rowInk = (x) => inkAt(x, y)
          || (y > 0 && inkAt(x, y - 1))
          || (y < h - 1 && inkAt(x, y + 1));
        let leftEdge = -1;
        for (let x = axisPx; x >= minX; x -= 1) { if (rowInk(x)) { leftEdge = x; break; } }
        if (leftEdge < 0) continue;
        let rightEdge = -1;
        for (let x = axisPx + 1; x <= maxX; x += 1) { if (rowInk(x)) { rightEdge = x; break; } }
        if (rightEdge < 0) continue;
        // The junction signature REQUIRES an empty gap at the axis — the
        // placket interior. Ink on/next to the axis cell means this row is a
        // continuous structure (band interior, drawn CF line, gore ink), not
        // an interrupted seam; the direct paths above own those cases.
        if (leftEdge >= axisPx - 1 || rightEdge <= axisPx + 1) continue;
        if (rightEdge - leftEdge > maxGapPx) continue;
        if (Math.abs((leftEdge + rightEdge) / 2 - axisPx) > Math.max(4, bboxW * 0.04)) continue;
        const runFrom = (x0, dir) => {
          let run = 0, hole = 0, x = x0;
          while (x >= minX && x <= maxX) {
            if (rowInk(x)) { run += 1; hole = 0; }
            else { hole += 1; if (hole > maxHole) break; }
            x += dir;
          }
          return run;
        };
        if (runFrom(leftEdge, -1) < minRunPx) continue;
        if (runFrom(rightEdge, +1) < minRunPx) continue;
        const vRun = (x) => {
          let run = 0;
          for (let yy = Math.max(minY, y - vEdgeRun); yy <= Math.min(maxY, y + vEdgeRun); yy += 1) {
            if (inkAt(x, yy)
              || (x > 0 && inkAt(x - 1, yy))
              || (x < w - 1 && inkAt(x + 1, yy))) run += 1;
          }
          return run;
        };
        if (vRun(leftEdge) < vEdgeRun) continue;
        if (vRun(rightEdge) < vEdgeRun) continue;
        cradleCfTop = { x: axisPx / w, y: y / h };
        cradleCfTopJunction = true;
        cradleCfTopReject = null;
      }
    }

    return {
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
    };
  }
