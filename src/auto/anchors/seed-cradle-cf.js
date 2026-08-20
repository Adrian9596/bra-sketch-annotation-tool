// POM 6 / POM 8 center-front cradle geometry for the anchor seed pass: the
// gore-bottom contour analysis (symmetric CF crest, legacy horizontal-seam
// fallback), the cradleCfFromCupSeam rescue projection, and the standalone
// crest tier (US-015 / ADR 0023) that seeds cradle-cf-top when the direct
// CF-seam detector missed.
// Source part for app.js. Run `npm run build` after editing.
//
// Pure contour geometry over detection.contours plus the frontView box that
// seed-view-resolution.js resolved. Its result feeds the cradle-cf-top seed
// built by buildBaselineAnchorSeeds (seed-view-resolution.js) and is stashed
// on `detection` for the landmark-QA layer the orchestrator runs next.

  // Gore bottom (POM 6/8 cradle-cf-top refinement). detection.cradleCfTop pins
  // to the global cradle ROW (the strongest horizontal band), which can sit
  // BELOW the true cup↔cradle seam at CF. Two contour shapes are valid:
  //   1. a symmetric CREST at CF whose same traced edge descends on both
  //      sides (the center-front top edge in the TD-corrected demo/1.jpg),
  //   2. a short horizontal seam crossing the axis (legacy fallback).
  // Prefer the crest when it is present. This prevents a lower horizontal
  // lace/seam row from winning merely because it is denser. Returns y/null.
  // Returns { refinedY, crestY, crestBelowCfY }: refinedY = the US-012
  // refinement result (guarded crest, else legacy horizontal seam, else
  // null) used to snap an EXISTING direct detection up to the seam; crestY
  // = the raw topmost symmetric crest regardless of the raised-panel
  // guards; crestBelowCfY = the topmost crest sitting BELOW cf-top (POM 8
  // ordering) — on a plunge gore the neckline-V samples just above cf-top
  // and the gore-top samples just below it belong to the same contour, so
  // the standalone crest tier (US-015 / ADR 0023) must select with the
  // cf-top floor applied, not filter afterwards.
  function goreBottomYFromContours(detection, frontView) {
      const none = { refinedY: null, crestY: null, crestBelowCfY: null };
      const C = detection.contours;
      if (!C || !Array.isArray(C.paths) || detection.axisX == null) return none;
      const axisX = detection.axisX;
      const detectedY = detection.cradleCfTop && detection.cradleCfTop.y != null
        ? detection.cradleCfTop.y
        : (detection.cradleY != null ? detection.cradleY : null);
      if (detectedY == null) return none;
      const viewH = frontView && frontView.height > 0
        ? frontView.height
        : (detection.bbox && detection.bbox.height ? detection.bbox.height : 1);

      // Search only the structural band immediately above the detected cradle
      // row. A neckline/gore detail much higher in the cup is not a POM 6
      // candidate. The desired crest is an upside-down U: points on BOTH arms
      // of the SAME contour sit lower than its near-axis point.
      const crestLo = Math.max(0, detectedY - Math.max(0.10, viewH * 0.28));
      const crestHi = detectedY - Math.max(0.008, viewH * 0.015);
      const axisTol = Math.max(0.012, (frontView && frontView.width ? frontView.width : 1) * 0.05);
      const minArmDx = Math.max(0.018, (frontView && frontView.width ? frontView.width : 1) * 0.055);
      const maxArmDx = Math.max(minArmDx * 2, (frontView && frontView.width ? frontView.width : 1) * 0.30);
      const minDrop = Math.max(0.006, viewH * 0.012);
      const symmetryTol = Math.max(0.020, viewH * 0.055);
      let bestCrest = null;
      let bestCrestBelow = null;
      const cfFloorY = detection.cfTopY != null ? detection.cfTopY + 0.004 : null;
      for (const p of C.paths) {
        const b = p && p.bbox;
        if (!b || b.width < minArmDx * 2) continue;
        if (!(b.x < axisX - minArmDx && b.x + b.width > axisX + minArmDx)) continue;
        const samples = samplePathPoints(p);
        if (!Array.isArray(samples) || samples.length < 5) continue;
        for (const center of samples) {
          // The symmetry axis is a fitted prior and can sit a few pixels off
          // the drawn CF crest. Use the nearest contour sample in a tight CF
          // zone instead of forcing an interpolated crossing onto a displaced
          // axis (which selects the lower bound edge on demo/1.jpg).
          if (Math.abs(center.x - axisX) > axisTol) continue;
          if (center.y < crestLo || center.y > crestHi) continue;
          let left = null, right = null;
          for (const q of samples) {
            const dx = q.x - axisX;
            if (dx <= -minArmDx && dx >= -maxArmDx && q.y >= center.y + minDrop) {
              if (!left || q.y < left.y || (q.y === left.y && Math.abs(dx + minArmDx) < left.dist)) {
                left = { y: q.y, dist: Math.abs(dx + minArmDx) };
              }
            }
            if (dx >= minArmDx && dx <= maxArmDx && q.y >= center.y + minDrop) {
              if (!right || q.y < right.y || (q.y === right.y && Math.abs(dx - minArmDx) < right.dist)) {
                right = { y: q.y, dist: Math.abs(dx - minArmDx) };
              }
            }
          }
          if (!left || !right) continue;
          const leftDrop = left.y - center.y;
          const rightDrop = right.y - center.y;
          if (leftDrop < minDrop || rightDrop < minDrop) continue;
          if (Math.abs(leftDrop - rightDrop) > symmetryTol) continue;
          const score = Math.min(leftDrop, rightDrop) - Math.abs(leftDrop - rightDrop) * 0.5;
          // Paired seam/stitch lines can produce two valid crests. The TD
          // landmark is the UPPER black edge, so vertical order wins once the
          // symmetric-crest guards have passed; score only breaks same-row ties.
          if (!bestCrest || center.y < bestCrest.y - 0.002
            || (Math.abs(center.y - bestCrest.y) <= 0.002 && score > bestCrest.score)) {
            bestCrest = { y: center.y, score };
          }
          // Same selection, restricted below the cf-top floor (POM 8 keeps a
          // positive length) — used by the standalone crest tier.
          if (cfFloorY != null && center.y >= cfFloorY) {
            if (!bestCrestBelow || center.y < bestCrestBelow.y - 0.002
              || (Math.abs(center.y - bestCrestBelow.y) <= 0.002 && score > bestCrestBelow.score)) {
              bestCrestBelow = { y: center.y, score };
            }
          }
        }
      }
      const crestRawY = bestCrest ? clamp01(bestCrest.y) : null;
      const crestBelowCfY = bestCrestBelow ? clamp01(bestCrestBelow.y) : null;
      let refined = null;
      if (bestCrest) {
        // This override is specific to a RAISED cradle panel, not every
        // symmetric curve in a cup/gore. The crest must coincide with the
        // independently detected underbust boundary, be materially above the
        // lower cradle-row prior, and still sit below CF top (POM 8 ordering).
        // Without all three signals, preserve the existing direct/placket/
        // projected behavior rather than promoting a neckline or gore curve.
        const ubY = detection.underbustY;
        const cfY = detection.cfTopY;
        const alignsUnderbust = ubY != null
          && Math.abs(bestCrest.y - ubY) <= Math.max(0.018, viewH * 0.04);
        const meaningfullyRaised = ubY != null
          && detectedY - ubY >= Math.max(0.08, viewH * 0.16);
        const belowCfTop = cfY == null
          || bestCrest.y - cfY >= Math.max(0.025, viewH * 0.06);
        if (alignsUnderbust && meaningfullyRaised && belowCfTop) refined = clamp01(bestCrest.y);
      }

      // Legacy horizontal-seam fallback for styles without a visible crest.
      if (refined == null) {
        const ubY = detection.underbustY != null ? detection.underbustY
          : (detection.chestY != null ? detection.chestY : 0);
        const bY = detection.bandY != null ? detection.bandY : 1;
        if (bY > ubY) {
          const lo = ubY + (bY - ubY) * 0.15;   // clearly below the underbust seam
          const hi = bY - (bY - ubY) * 0.05;    // clearly above the band
          let best = null;
          for (const p of C.paths) {
            const b = p && p.bbox; if (!b) continue;
            const minX = b.x, maxX = b.x + b.width, midY = b.y + b.height / 2;
            if (!(minX < axisX - 0.01 && maxX > axisX + 0.01)) continue; // straddles CF
            if (b.height > 0.12 || b.width < 0.03) continue;             // horizontal seam
            if (midY < lo || midY > hi) continue;                        // cradle region
            if (!best || midY < best) best = midY;                       // topmost = gore bottom
          }
          if (best != null) refined = clamp01(best);
        }
      }
      return { refinedY: refined, crestY: crestRawY, crestBelowCfY };
  }

  // Resolves the three cradle-cf inputs the baseline seed set needs:
  // cradleCfFromCupSeam (the POM 7 seam rescue gate), cradleCfTopY (the
  // US-012 snap-up refinement of a direct detection), and cradleCfCrestY
  // (the standalone US-015 / ADR 0023 crest tier). Also stashes the crest
  // decision on `detection` for the landmark-QA layer.
  function resolveCradleCfSeed(detection, seedCtx) {
    const { frontView } = seedCtx;

    // POM 6 rescue: when the direct CF-seam detector missed (no cradleCfTop)
    // but the bottom-cup cradle seam WAS found (cradleCupTop — the POM 7 top),
    // extend that detected seam horizontally to the CF axis as an APPROXIMATE
    // POM 6 top. It seeds low-confidence + reviewRequired (the landmark QA
    // layer downstream tags it accordingly) so the TD still verifies; this only replaces a hard
    // REVIEW_ONLY demotion with a reviewable starting line, and degrades
    // gracefully — POM 6 stays REVIEW_ONLY when cradleCupTop is also missing.
    // No rule-JSON change: cf-bottom still derives onto the band line via the
    // existing anchor-schema drop_to_line rule.
    // Gate the projection to trusted seam tiers ('strong'/'seam'): a
    // guide/arc-tier POM 7 commit (ADR 0021/0022) follows a curved wire whose
    // bottom-cup y says nothing about the CF gore boundary — projecting it
    // would seed a confidently-wrong POM 6/8 top (e.g. demo5's plunge gore).
    const cradleCfFromCupSeam = !detection.cradleCfTop
      && !!detection.cradleCupTop
      && (detection.cradleCupTier === 'strong' || detection.cradleCupTier === 'seam');

    const detCradleCfY = detection.cradleCfTop ? detection.cradleCfTop.y : null;
    const goreBottom = goreBottomYFromContours(detection, frontView);
    const goreBottomY = goreBottom.refinedY;
    // Only snap UP to the seam (never below the detected cradle row).
    const cradleCfTopY = (detCradleCfY != null && goreBottomY != null && goreBottomY < detCradleCfY)
      ? goreBottomY
      : detCradleCfY;
    // Standalone crest tier (US-015 / ADR 0023): the direct CF-seam detector
    // missed (row prior on the wrong structure, or no ink at the axis — e.g.
    // a plunge gore whose cups meet at a crest well above the wire bottoms),
    // but the contours show a symmetric CF crest sitting below cf-top and
    // above the cradle row / band. Seed cradle-cf-top there — low confidence,
    // source seamCrest, reviewRequired — instead of leaving POM 6/8 in hard
    // REVIEW_ONLY. Stashed on `detection` BEFORE the QA build so the QA layer
    // classifies the same decision this seeding pass applies.
    const cradleCfCrestY = (!detection.cradleCfTop
      && goreBottom.crestBelowCfY != null
      && (detection.cradleY == null || goreBottom.crestBelowCfY < detection.cradleY)
      && (detection.bandY == null || goreBottom.crestBelowCfY < detection.bandY - 0.02))
      ? goreBottom.crestBelowCfY : null;
    detection.cradleCfCrestSeedY = cradleCfCrestY;

    return { cradleCfFromCupSeam, cradleCfTopY, cradleCfCrestY };
  }
