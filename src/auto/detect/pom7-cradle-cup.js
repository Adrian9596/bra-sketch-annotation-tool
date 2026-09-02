// POM 7 — the cradle/cup-bottom seam at the BOTTOM-CUP position (the
// cradle-cup-top / cradle-cup-bottom landmarks). One function,
// findCradleCupSeam(ctx), holding every acceptance tier: the 'strong' vertical
// guide and 'seam' seam+baseline tiers with their side-seam discriminators, the
// sparse dashed-guide tier (ADR 0021), and the traced-underwire 'arc' tier
// (US-014 / ADR 0022) with its CF-clearance floor.
//
// The most heavily tuned code in the detector — every threshold here was fitted
// against the demo corpus, not derived. `npm run pom7-limitations` is its
// specific guard, alongside golden / accuracy / contract.
//
// Pure: it reads only the pixel context handed to it (including the caller's
// hem-following helper) and returns every value the landmark stage needs. Its
// caller is src/auto/detect/landmark-stage.js; the sibling POM 6 seam detector
// is src/auto/detect/pom6-cradle-cf.js, and the arc tier reads the cup bottom
// through findCupBottomFromInk in src/auto/detect/front-landmarks.js.
// Source part for app.js. Run `npm run build` after editing.

  // Detect POM 7's cradle-at-bottom-cup endpoints. `ctx` carries the pixel-space
  // facts the block below reads by name (masks, bbox, axis, row/column picks and
  // their strengths, the validated apexes, and hemNormAtColumn — the caller's
  // per-column hem lookup, US-061). Every value it decides is returned; nothing
  // outside is mutated.
  function findCradleCupSeam(ctx) {
    const {
      dark, rawDark, w, h, bounds,
      minX, maxX, bboxW, bboxH,
      axisPx, peakSep,
      rowNoiseFloor,
      bandRow, bandY,
      cradleRow, cradleStrength, cradleY,
      sideLeftCol, sideRightCol, sideLeftX, sideRightX,
      apexLeft, apexRight,
      hemNormAtColumn,
      // Independent corroboration for `cradleRow` from POM 6's own CF-axis
      // seam checks: true when findCradleCfTop confirmed a real
      // seam AT this exact row via its 'direct' or 'dip' tier — both anchor
      // on `cradleRow` itself (only the row-agnostic 'junction' tier does
      // not, so it is excluded). See the ARC_MIN_CF_CLEARANCE use below.
      cradleRowConfirmedAtCf,
    } = ctx;

    // ---- Cradle-at-bottom-cup (POM 7 endpoints) ----
    // POM 7 measures the cradle/cup-bottom seam height at the BOTTOM-CUP
    // position (away from the CF axis, inside the cup-side region). Its top
    // endpoint sits where the cup-bottom seam meets the cradle row outside the
    // CF guard; its bottom endpoint sits directly below on the band baseline.
    //
    // We require:
    //   - cradleY detected (cradleStrength > rowNoiseFloor * 1.3, already gated)
    //   - bandRow detected
    //   - a column x between the CF axis (with a generous distance buffer so
    //     POM 7 reads as distinct from POM 6) and the side seam (with a buffer
    //     so it doesn't snap to the POM 11 side seam ink)
    //   - that column carries cradle-row ink (cup-bottom seam evidence)
    //   - that column also carries band-row ink (real baseline beneath it)
    // When any guard fails the anchors are NOT seeded and POM 7 demotes to
    // REVIEW_ONLY downstream — no horizontal-ratio fallback.
    let cradleCupTop = null;
    let cradleCupBottom = null;
    let cradleCupSide = 0;
    // Provenance tier of the committed seam: 'strong' (vertical guide),
    // 'seam' (pattern-3 seam+baseline), or 'guide' (sparse dashed guide —
    // NEW relaxed tier; drawn for TD review but NEVER fed to the cupModel,
    // see buildCupModel and ADR 0021).
    let cradleCupTier = null;
    let cradleCupTopInkRatio = 0;
    let cradleCupBandInkRatio = 0;
    let cradleCupColInkRatio = 0;
    let cradleCupSegmentsWithInk = 0;
    let cradleCupSegmentCount = 0;
    let cradleCupEdgePenalty = 1;
    let cradleCupReject = null;
    if (cradleRow < 0 || cradleStrength <= rowNoiseFloor * 1.3) {
      cradleCupReject = 'no cradle row detected';
    } else if (bandRow < 0) {
      cradleCupReject = 'no band row detected';
    } else {
      // Distance buffers (in px). CF-side buffer keeps POM 7 well off the
      // CF axis (≥ 18% of bbox width, no smaller than 2× peakSep). Side
      // buffer is intentionally small: real POM 7 lines often sit close to
      // the side seam, so we only push off by ~3% of bbox width (just enough
      // to avoid snapping directly onto POM 11) and rely on a soft edge
      // penalty in scoring to bias away from the seam when the line is
      // ambiguous.
      const cfAxisBuffer = Math.max(peakSep * 2, Math.round(bboxW * 0.18));
      const sideBuffer  = Math.max(2, Math.round(bboxW * 0.03));
      const ySpan = 2;
      const xWin = Math.max(3, Math.round(bboxW * 0.03));
      const yBandSpan = Math.max(2, Math.round(bboxH * 0.012));
      const yLo = Math.max(0, cradleRow - ySpan);
      const yHi = Math.min(h - 1, cradleRow + ySpan);
      const yBandLo = Math.max(0, bandRow - yBandSpan);
      const yBandHi = Math.min(h - 1, bandRow + yBandSpan);

      // For each side (left=-1, right=+1) sweep candidate columns and score
      // by cradle-row ink, weighted by band-row support, vertical evidence,
      // and position priors (bonus for being far from CF, soft penalty when
      // pressed against the side seam).
      //
      // Vertical-line evidence (colRatio / segmentsWithInk) is a CONFIDENCE
      // BOOSTER, not a hard requirement. Per rule.md POM 7 contract, three
      // evidence patterns are acceptable:
      //   1. explicit vertical guide line from cradle to baseline
      //   2. segmented/dashed vertical support spanning cradle-to-baseline
      //   3. strong cradle-bottom-cup seam plus clean baseline projection,
      //      with no conflicting negative evidence
      // Patterns 1 and 2 light up colRatio/segmentsWithInk. Pattern 3 does
      // not — most real bra sketches show the cup-bottom seam + band but
      // no drawn vertical measurement line (that's what the tool drafts).
      // So we measure vertical-guide quality but accept candidates without
      // it as long as the side-seam discriminator (below) does NOT fire and
      // the cradle/band seam ink itself is strong.
      //   - colRatio = fraction of rows between cradleRow and bandRow that
      //     carry any ink inside the candidate column window.
      //   - segmentsWithInk / segmentCount = how many evenly-spaced segments
      //     of the gap have at least one inked row.
      const colMinRatio = 0.28;
      const segmentCount = 5;
      const segmentMin = 4;
      // Minimum cradle-row ink ratio when NO vertical guide is present. The
      // permissive 0.05 floor at line ~1028 lets faint cup-arc tangent ink
      // qualify; for pattern 3 (no guide) we need actual seam ink at the
      // candidate column, not just a single grazing curve point.
      const cradleRatioNoGuide = 0.25;
      // Guide tier (ADR 0021): a sparse dashed guide (gap ≥ ~8 px) hits every
      // segment but its continuous colRatio sits below the strong floor. When
      // BOTH today's acceptance paths fail, such a candidate may still commit
      // at tier 'guide' — drawn low-confidence + reviewRequired, and ignored
      // by the cupModel. 0.18 admits real sparse dashes (2px dash / 8px gap
      // ≈ 0.25) while genuinely ambiguous patterns (gap 12 ≈ 0.17) stay out.
      const dashedColMinRatio = 0.18;
      // Span between rows for the vertical check — strictly INSIDE the gap
      // so cradleRow / bandRow ink doesn't contribute.
      const vGapLo = Math.min(cradleRow + ySpan + 1, bandRow - yBandSpan - 1);
      const vGapHi = Math.max(cradleRow + ySpan + 1, bandRow - yBandSpan - 1);
      // Side-seam-discriminator range: a narrow band ABOVE the cradle row.
      // POM 7 is bounded above by the cradle (no ink there), while the side
      // seam runs from the chest line down through the cradle down to the
      // band so it has full ink in this region. A column whose window has
      // dense ink here is the side seam, not POM 7.
      const aboveLo = Math.max(0, cradleRow - Math.max(6, Math.round(bboxH * 0.10)));
      const aboveHi = Math.max(0, cradleRow - ySpan - 1);
      const aboveMaxRatio = 0.35;
      const sideCandidates = [];
      const guideCandidates = [];      // dashed-guide tier pool (ADR 0021)
      let anyPassedRows = false;       // ≥1 candidate passed cradle+band rows
      let anyPassedColumn = false;     // ≥1 candidate also had vertical ink
      let anyRejectedAsSideSeam = false;
      for (const side of [-1, +1]) {
        let edgeCol;
        if (side < 0) {
          edgeCol = sideLeftCol > 0 ? sideLeftCol : minX + Math.round(bboxW * 0.05);
        } else {
          edgeCol = sideRightCol > 0 ? sideRightCol : maxX - Math.round(bboxW * 0.05);
        }
        const xLo = side < 0
          ? Math.max(minX + 1, edgeCol + sideBuffer)
          : Math.max(minX + 1, axisPx + cfAxisBuffer);
        const xHi = side < 0
          ? Math.min(maxX - 1, axisPx - cfAxisBuffer)
          : Math.min(maxX - 1, edgeCol - sideBuffer);
        if (xHi <= xLo) continue;
        let bestX = -1;
        let bestScore = 0;
        let bestCradleInk = 0;
        let bestBandInk = 0;
        let bestColRatio = 0;
        let bestSegmentsHit = 0;
        let bestEdgePenalty = 1;
        let bestTier = null;
        let bestGuideX = -1;
        let bestGuideScore = 0;
        let bestGuideCradleInk = 0;
        let bestGuideBandInk = 0;
        let bestGuideColRatio = 0;
        let bestGuideSegmentsHit = 0;
        let bestGuideEdgePenalty = 1;
        for (let xc = xLo; xc <= xHi; xc += 1) {
          const cxLo = Math.max(0, xc - xWin);
          const cxHi = Math.min(w - 1, xc + xWin);
          let cradleInk = 0, cradleWin = 0;
          for (let y = yLo; y <= yHi; y += 1) {
            for (let x = cxLo; x <= cxHi; x += 1) {
              cradleWin += 1;
              if (dark[y * w + x]) cradleInk += 1;
            }
          }
          const cradleRatio = cradleWin > 0 ? cradleInk / cradleWin : 0;
          if (cradleRatio < 0.05) continue;
          let bandInk = 0, bandWin = 0;
          for (let y = yBandLo; y <= yBandHi; y += 1) {
            for (let x = cxLo; x <= cxHi; x += 1) {
              bandWin += 1;
              if (dark[y * w + x]) bandInk += 1;
            }
          }
          const bandRatio = bandWin > 0 ? bandInk / bandWin : 0;
          if (bandRatio < 0.05) continue;
          anyPassedRows = true;
          // Vertical column ink between rows. Count rows-with-ink (for the
          // overall ratio) AND segments-with-ink (for span coverage). A
          // dashed line has ~40% rows inked but hits every segment; a short
          // decorative tick may exceed the ratio locally but only hits 1-2
          // segments and fails the span check.
          // Use the RAW mask (before connected-components filtering) for the
          // vertical ink scan. The component filter drops tiny shapes, and
          // each individual dash of a dashed POM 7 line is a 3×2 px component
          // that falls below the floor — so reading from `dark` here would
          // report zero ink for an obvious dashed line. The raw mask still
          // shows the dashes.
          let colRows = 0;
          let colRowsWithInk = 0;
          const segHits = new Uint8Array(segmentCount);
          if (vGapHi > vGapLo) {
            const gapLen = vGapHi - vGapLo + 1;
            for (let y = vGapLo; y <= vGapHi; y += 1) {
              colRows += 1;
              let inked = false;
              for (let x = cxLo; x <= cxHi; x += 1) {
                if (rawDark[y * w + x]) { inked = true; break; }
              }
              if (inked) {
                colRowsWithInk += 1;
                let segIdx = Math.floor(((y - vGapLo) / gapLen) * segmentCount);
                if (segIdx >= segmentCount) segIdx = segmentCount - 1;
                segHits[segIdx] = 1;
              }
            }
          }
          const colRatio = colRows > 0 ? colRowsWithInk / colRows : 0;
          let segmentsHit = 0;
          for (let s = 0; s < segmentCount; s += 1) {
            if (segHits[s]) segmentsHit += 1;
          }
          // verticalGuideStrong = pattern 1/2 (explicit or dashed guide
          // line). Without it we fall back to pattern 3 (semantic seam +
          // baseline projection) which requires both a stronger cradle
          // window ink ratio AND horizontal seam continuity (the cradle/
          // cup-bottom seam extends across the bottom-cup zone, whereas a
          // cup-outline arc tangent only piles ink at a single point).
          const verticalGuideStrong = (colRatio >= colMinRatio) && (segmentsHit >= segmentMin);
          // Sparse dashed guide: every segment inked but the continuous ratio
          // is below the strong floor. Only relevant when pattern 3 ALSO
          // fails — then the candidate survives as guide-tier (ADR 0021)
          // instead of being rejected outright.
          const dashedGuidePresent = !verticalGuideStrong
            && (segmentsHit >= segmentMin)
            && (colRatio >= dashedColMinRatio);
          // dashedOnly = this candidate exists only via the guide tier. Such
          // candidates must not disturb today's reject-reason flags or score
          // pool — the tier is strictly additive.
          let dashedOnly = false;
          let seamHorizontalRun = 0;
          if (!verticalGuideStrong) {
            if (cradleRatio < cradleRatioNoGuide) {
              if (!dashedGuidePresent) continue;
              dashedOnly = true;
            }
            // Horizontal seam extent: a real cradle/cup-bottom seam draws
            // ink continuously across the bottom-cup region; a cup-outline
            // arc tangent piles ink only in ~10-15 contiguous columns
            // around the cup ellipse center. Measure the LONGEST run of
            // inked columns at cradleRow ± 1 (3-row band tolerates
            // anti-aliasing) inside a wider window so a real seam
            // (spanning 30%+ of bboxW) easily clears the threshold while a
            // cup tangent (~8% of bboxW) does not.
            const runWin = Math.max(20, Math.round(bboxW * 0.18));
            const runLo = Math.max(0, xc - runWin);
            const runHi = Math.min(w - 1, xc + runWin);
            const runYLo = Math.max(0, cradleRow - 1);
            const runYHi = Math.min(h - 1, cradleRow + 1);
            let currentRun = 0;
            let singleRowRun = 0;
            let currentSingle = 0;
            for (let x = runLo; x <= runHi; x += 1) {
              let inkedBand = false;
              for (let y = runYLo; y <= runYHi; y += 1) {
                if (rawDark[y * w + x]) { inkedBand = true; break; }
              }
              if (inkedBand) {
                currentRun += 1;
                if (currentRun > seamHorizontalRun) seamHorizontalRun = currentRun;
              } else {
                currentRun = 0;
              }
              if (rawDark[cradleRow * w + x]) {
                currentSingle += 1;
                if (currentSingle > singleRowRun) singleRowRun = currentSingle;
              } else {
                currentSingle = 0;
              }
            }
            // Accept either: a long contiguous run in the 3-row band (lets
            // anti-aliased seams pass even when no single row is fully
            // continuous), OR a meaningful run at the exact cradleRow.
            const minBandRun = Math.max(28, Math.round(bboxW * 0.16));
            const minSingleRun = Math.max(18, Math.round(bboxW * 0.10));
            if (!dashedOnly && seamHorizontalRun < minBandRun && singleRowRun < minSingleRun) {
              if (!dashedGuidePresent) continue;
              dashedOnly = true;
            }
          }
          // Reject side-seam-like columns: a long, continuous vertical run of
          // ink ABOVE the cradle row in any column of the candidate window
          // means we're sampling a vertical seam that runs from chest to
          // band, not a measurement line that starts at the cup-bottom.
          //
          // We use a per-column maximum instead of "rows with any ink"
          // because a cup outline curve that arcs across the window inks
          // ~half the rows in the above range (each row hit by a single x
          // value where the curve crosses) but no single column is densely
          // filled. The side seam, in contrast, fills one column for the
          // entire vertical span.
          let aboveRows = 0;
          let aboveMaxColRun = 0;
          if (aboveHi > aboveLo) {
            aboveRows = aboveHi - aboveLo + 1;
            for (let x = cxLo; x <= cxHi; x += 1) {
              let run = 0;
              for (let y = aboveLo; y <= aboveHi; y += 1) {
                if (rawDark[y * w + x]) run += 1;
              }
              if (run > aboveMaxColRun) aboveMaxColRun = run;
            }
          }
          const aboveRatio = aboveRows > 0 ? aboveMaxColRun / aboveRows : 0;
          if (aboveRatio > aboveMaxRatio) {
            // Guide-only candidates would have been rejected before reaching
            // this guard under today's rules — keep the reject-reason flags
            // (and therefore the user-facing messages) byte-identical.
            if (!dashedOnly) anyRejectedAsSideSeam = true;
            continue;
          }
          // HARD reject candidates that sit within 5% of the side seam
          // column AND do NOT have an explicit/dashed guide line (pattern
          // 1 or 2). The "seam + baseline projection" path (pattern 3) is
          // too easy to spoof with a band-zigzag tail near the side seam:
          // there's enough cradleRow ink in the bottom-cup region and
          // enough bandRow ink at the seam itself for `cradleRatio` and
          // `bandRatio` to clear, but the candidate column is really the
          // bottom of the side seam, not a cup-bottom measurement. With
          // an explicit guide line we trust the TD drew the POM 7 line on
          // purpose; without one, we require a real bottom-cup gap.
          const distFromEdgePx = Math.abs(xc - edgeCol);
          const minDistFromSide = Math.max(6, Math.round(bboxW * 0.05));
          // Without an explicit guide, require a real 5%-of-bbox gap from the
          // side seam. WITH a guide we normally trust the TD drew POM 7 on
          // purpose — but a band ZIG-ZAG TAIL can spoof verticalGuideStrong AND
          // land right on the seam column, so still hard-reject a candidate
          // essentially COINCIDENT with the side seam even when guided (D8): a
          // genuine hand-drawn POM 7 line sits clearly inboard of the seam.
          const guardDistPx = verticalGuideStrong
            ? Math.max(3, Math.round(bboxW * 0.02))
            : minDistFromSide;
          if (distFromEdgePx < guardDistPx) {
            if (!dashedOnly) anyRejectedAsSideSeam = true;
            continue;
          }
          if (!dashedOnly) anyPassedColumn = true;
          // Distance prior — reward being far from CF (≥ 20% of bbox width
          // earns full bonus). Apply a SOFT penalty for closeness to the
          // side seam: never below 0.5 even when adjacent, smoothly
          // increasing to 1.0 by 10% of bbox width. This biases scoring
          // away from POM 11 without hard-rejecting real POM 7 lines that
          // genuinely sit close to the side.
          const distFromAxis = Math.abs(xc - axisPx) / Math.max(1, bboxW);
          const distFromEdge = Math.abs(xc - edgeCol) / Math.max(1, bboxW);
          const farBonus = Math.min(1, distFromAxis / 0.2);
          const edgePenalty = 0.5 + 0.5 * Math.min(1, distFromEdge / 0.10);
          const segmentBonus = segmentsHit / segmentCount;
          // Vertical-guide multiplier: candidates with a clear guide line
          // outscore those without. Floor at 0.35 so pattern-3 candidates
          // (no guide, but real cradle seam) can still win when no guide
          // candidate exists. Guide-tier (dashed-only) candidates score into
          // their OWN pool — they can never displace a candidate accepted by
          // today's rules (ADR 0021 additivity).
          if (dashedOnly) {
            const guideScore = cradleRatio * (0.6 + 0.4 * bandRatio)
              * (0.55 + 0.45 * farBonus) * edgePenalty
              * (0.45 + 0.25 * colRatio * segmentBonus);
            if (guideScore > bestGuideScore) {
              bestGuideScore = guideScore;
              bestGuideX = xc;
              bestGuideCradleInk = cradleRatio;
              bestGuideBandInk = bandRatio;
              bestGuideColRatio = colRatio;
              bestGuideSegmentsHit = segmentsHit;
              bestGuideEdgePenalty = edgePenalty;
            }
            continue;
          }
          const guideMultiplier = verticalGuideStrong
            ? (0.6 + 0.4 * colRatio * segmentBonus)
            : 0.35;
          const score = cradleRatio * (0.6 + 0.4 * bandRatio)
            * (0.55 + 0.45 * farBonus) * edgePenalty * guideMultiplier;
          if (score > bestScore) {
            bestScore = score;
            bestX = xc;
            bestCradleInk = cradleRatio;
            bestBandInk = bandRatio;
            bestColRatio = colRatio;
            bestSegmentsHit = segmentsHit;
            bestEdgePenalty = edgePenalty;
            bestTier = verticalGuideStrong ? 'strong' : 'seam';
          }
        }
        if (bestX > 0) {
          sideCandidates.push({
            side, x: bestX, score: bestScore,
            cradleInk: bestCradleInk, bandInk: bestBandInk,
            colRatio: bestColRatio, segmentsHit: bestSegmentsHit,
            edgePenalty: bestEdgePenalty,
            tier: bestTier,
          });
        }
        if (bestGuideX > 0) {
          guideCandidates.push({
            side, x: bestGuideX, score: bestGuideScore,
            cradleInk: bestGuideCradleInk, bandInk: bestGuideBandInk,
            colRatio: bestGuideColRatio, segmentsHit: bestGuideSegmentsHit,
            edgePenalty: bestGuideEdgePenalty,
            tier: 'guide',
          });
        }
      }
      // Guide-tier fallback (ADR 0021): considered ONLY when today's
      // acceptance found nothing on either side, so images that detect today
      // are byte-identical. A guide winner commits at tier 'guide' — seeded
      // low-confidence + reviewRequired, and ignored by the cupModel.
      const acceptedPool = sideCandidates.length ? sideCandidates : guideCandidates;
      if (!acceptedPool.length) {
        if (anyRejectedAsSideSeam && !anyPassedColumn) {
          cradleCupReject = 'candidate column looks like the side seam, not a POM 7 line (ink extends above the cradle row)';
        } else if (anyPassedRows && !anyPassedColumn) {
          // Reached when every cradle+band candidate column also failed the
          // side-seam discriminator OR the no-guide cradle threshold. The
          // user-facing reason favours "weak seam evidence" since that is
          // the more common cause on real sketches (the side-seam case is
          // covered above when it dominated).
          cradleCupReject = 'no clear cradle/cup-bottom seam at bottom-cup zone (weak or ambiguous seam ink)';
        } else {
          cradleCupReject = 'no cradle/band ink support in either bottom-cup region';
        }
      } else {
        acceptedPool.sort((a, b) => b.score - a.score);
        const winner = acceptedPool[0];
        cradleCupSide = winner.side;
        cradleCupTopInkRatio = winner.cradleInk;
        cradleCupBandInkRatio = winner.bandInk;
        cradleCupColInkRatio = winner.colRatio;
        cradleCupSegmentsWithInk = winner.segmentsHit;
        cradleCupSegmentCount = segmentCount;
        cradleCupEdgePenalty = winner.edgePenalty;
        cradleCupTop = { x: winner.x / w, y: cradleRow / h };
        // POM 7's bottom is a BAND ANCHOR: it must land on the garment's drawn
        // bottom edge, not on bandRow (the band ZONE used only to bound the
        // cup/cradle searches above — US-060). It follows the hem at its OWN
        // column so an arched or scalloped edge is tracked rather than averaged
        // (US-061); bandY is the fallback when that column shows no ink.
        cradleCupBottom = {
          x: winner.x / w,
          y: hemNormAtColumn(winner.x, bandY),
        };
        cradleCupTier = winner.tier || 'seam';
      }
    }

    // POM 7 arc tier (US-014 / ADR 0022): when neither the seam tiers nor the
    // dashed-guide tier committed, read the cup-bottom structure itself — the
    // traced underwire/cup-bottom arc (the same evidence the cupModel already
    // trusts for POM 9's bottom). Requires a validated apex on the same side.
    // Commits at tier 'arc': seeded low-confidence + reviewRequired, ignored
    // by the cupModel side-picker and bottom (only 'strong'/'seam' feed it).
    // The right cup is preferred to match the TD labeling convention (demo3).
    //
    // A cup-bottom / underwire arc is a DIP: it descends from the gore, bottoms
    // out near cup centre, and rises again toward the side seam. A curve whose
    // lowest point sits hard against the CF axis is not a cup base at all — on
    // a scoop-neck sketch it is the NECKLINE, which by construction reaches its
    // lowest point at centre front. findCupBottomFromInk only insets its search
    // band 20% off the axis, so such a curve is still descending when the
    // window clips it and then "wins" at the band's own inner wall.
    //
    // Measured deepest-point clearance across the demo corpus, as a fraction of
    // the CF -> side-seam half-width: committed seam/strong tiers land at
    // 52-84%, legitimate arcs at 40% (demo4) to 71% (demo1), while the neckline
    // mis-lock on "EvelynBliss vA 1.0" lands at 26% — where cradleY resolves to
    // the chest row (chestY is null there), so the search window never reaches
    // the real cradle seam ~0.15 further down. A 1/3 floor separates those with
    // margin on both sides. It is deliberately a FRACTION, not an absolute
    // normalized distance: the same garment feature then scores the same on a
    // 3-view board as on a lone sketch.
    //
    // Scoped to the arc tier on purpose — it is the last-resort, review-flagged
    // tier (ADR 0022); the seam tiers carry their own validation.
    //
    // The floor has two settings. `cradleY`'s OWN reliability varies:
    // on a genuine neckline mis-lock (the "EvelynBliss vA 1.0" case this floor
    // was calibrated against) `cradleRow` collapsed onto a spurious peak near
    // the chest, so a shallow clearance is exactly the mislock signature. But
    // when POM 6's independent CF-axis seam check (`cradleRowConfirmedAtCf`)
    // already proved real seam ink sits AT this row — a check that looks at
    // ink continuity and baseline projection, nothing to do with clearance —
    // a shallow clearance is no longer suspicious: it just means this style's
    // cup bottom genuinely sits close to CF (e.g. a narrow/plunge cup), and
    // the corroborated case measured empirically at 26% ("EvelynBliss vA 2.0",
    // same sketch family, real cradleRow with strong ink/baseline evidence and
    // a high-confidence POM 6 direct-tier match) should draw for TD review
    // instead of silently dropping POM 7 entirely.
    const ARC_MIN_CF_CLEARANCE = 1 / 3;
    const ARC_MIN_CF_CLEARANCE_CONFIRMED = 1 / 5;
    const arcClearanceFloor = cradleRowConfirmedAtCf
      ? ARC_MIN_CF_CLEARANCE_CONFIRMED : ARC_MIN_CF_CLEARANCE;
    if (!cradleCupTop && cradleY != null && bandY != null) {
      let arcClearanceReject = null;
      for (const side of [+1, -1]) {
        const apexPoint = side < 0 ? apexLeft : apexRight;
        if (!apexPoint) continue;
        const arcSideColPx = side < 0
          ? (Number.isFinite(sideLeftX) ? Math.round(sideLeftX * w) : minX + Math.round(bboxW * 0.05))
          : (Number.isFinite(sideRightX) ? Math.round(sideRightX * w) : maxX - Math.round(bboxW * 0.05));
        const arc = findCupBottomFromInk(dark, w, h, bounds, axisPx, arcSideColPx, apexPoint.y, cradleY, side);
        const arcHalfSpanPx = Math.abs(arcSideColPx - axisPx);
        const arcCfClearance = (arc && arc.bottomX != null && arcHalfSpanPx > 0)
          ? Math.abs(arc.bottomX * w - axisPx) / arcHalfSpanPx
          : 0;
        if (arc && arc.bottomX != null
            && arc.support >= 0.30
            && arc.bottomY > apexPoint.y + 0.08
            && arc.bottomY >= cradleY - 0.05
            && arc.bottomY < bandY - 0.01
            && arcCfClearance >= arcClearanceFloor) {
          cradleCupTop = { x: arc.bottomX, y: arc.bottomY };
          // Hem-following bottom, same rule as the seam/strong tier (US-061).
          cradleCupBottom = { x: arc.bottomX, y: hemNormAtColumn(arc.bottomX * w, bandY) };
          cradleCupSide = side;
          cradleCupTier = 'arc';
          cradleCupReject = null;
          arcClearanceReject = null;
          break;
        }
        if (arc && arc.bottomX != null
            && arcCfClearance < arcClearanceFloor
            && !arcClearanceReject) {
          arcClearanceReject = 'traced cup-bottom arc rejected: bottoms out '
            + Math.round(arcCfClearance * 100) + '% of the way from CF to the side seam, '
            + 'inside the ' + Math.round(arcClearanceFloor * 100)
            + '% cup-base floor (reads as the neckline curve, not a cup bottom)';
        }
      }
      // Keep the seam-tier reason — it says why we reached the fallback at all —
      // and append why the fallback also declined, so missingReason tells the
      // whole story instead of only the last stage that ran.
      if (!cradleCupTop && arcClearanceReject) {
        cradleCupReject = cradleCupReject
          ? (cradleCupReject + '; ' + arcClearanceReject)
          : arcClearanceReject;
      }
    }

    return {
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
    };
  }
