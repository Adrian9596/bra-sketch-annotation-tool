// Seed anchors from a detection result: walk the ANCHOR_SCHEMA and
// place each anchor in its normalized [0, 1] position on the source
// image. Source part for app.js. Run `npm run build` after editing.
//
// Anchors live between detection and POM generation: Detect Sketch seeds
// them, the TD drags any wrong ones, the POM generator reads them. The
// schema-driven layout means a new anchor name does not require new
// seeding code, only a row in auto_mode_rules/anchor-schema.json.

  // -------- Anchor layer (Phase 2 of the offline engine) --------
  //
  // Anchors live between detection and POM generation. Detect Sketch seeds
  // them with rough positions; the TD drags any wrong ones; the POM
  // generator then reads anchor positions to lay down 16 draft lines.
  // Anchors x/y are normalized [0, 1] in the source image's pixel space, so
  // they travel with the image (pan / zoom / resize / save).

  function seedAnchorsFromDetection(detection, sourceImage, options) {
    if (!detection || !detection.bbox || !sourceImage) return [];

    const views = Array.isArray(detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection.viewBoxes) ? detection.viewBoxes : []);
    // Prefer the explicit front/back classification produced by detection.
    // Older detection blobs (no classifier output) fall back to "primary view
    // is front, largest non-primary is back" so saved projects still load.
    const frontIdx = Number.isFinite(detection.frontViewIndex) && detection.frontViewIndex >= 0
      ? detection.frontViewIndex
      : (Number.isFinite(detection.primaryViewIndex) ? detection.primaryViewIndex : 0);
    const frontView = views[frontIdx] || detection.bbox;
    const frontInnerView = findDetectionViewByRole(detection, 'front_inner');
    let backView = null;
    if (Number.isFinite(detection.backViewIndex) && detection.backViewIndex >= 0) {
      backView = views[detection.backViewIndex] || null;
    } else if (views.length > 1) {
      const fallback = views
        .map((view, index) => ({ view, index }))
        .filter(item => item.index !== frontIdx)
        .sort((a, b) => (b.view.count || 0) - (a.view.count || 0))[0];
      backView = fallback ? fallback.view : null;
    }
    const inView = (view, rx, ry) => ({
      x: clamp01(view.x + view.width * rx),
      y: clamp01(view.y + view.height * ry),
    });
    const roleByKind = Object.create(null);
    for (const schema of ANCHOR_SCHEMA) {
      roleByKind[schema.kind] = defaultViewRoleForAnchorKind(schema.kind);
    }

    const bb = detection.bbox;
    const left  = bb.x;
    const right = bb.x + bb.width;
    const top   = bb.y;
    const halfW = bb.width / 2;
    const ax    = detection.axisX;
    const band  = detection.bandY;
    // Chest fallback: 30% down from bbox top if detection didn't surface one.
    const chest = detection.chestY != null
      ? detection.chestY
      : top + bb.height * 0.30;
    // Cup-bottom (cradle) fallback: midpoint between chest and band.
    const cradle = detection.cradleY != null
      ? detection.cradleY
      : chest + (band - chest) * 0.85;
    // Mid-cup y for inner-cup-width placement.
    const cupMid = chest + (band - chest) * 0.55;

    // Side seams: prefer detected columns; fall back to bbox edges with a
    // small inset so the seed doesn't sit literally on the bbox line.
    const sideL = detection.sideLeftX  != null ? detection.sideLeftX  : clamp01(left  + bb.width * 0.02);
    const sideR = detection.sideRightX != null ? detection.sideRightX : clamp01(right - bb.width * 0.02);

    const det = detection.confidence || {};

    // Inner cup sits on the side with the stronger local cup signal. Default
    // to the left cup because the bundled reference sketch shows it clearly.
    const icSide = (det.apexRight || 0) > (det.apexLeft || 0) + 0.08 ? +1 : -1;
    const icX    = ax + icSide * halfW * 0.12;
    const icHalf = halfW * 0.18;
    // POM 14 (shoulder-strap length) is a curved front-to-back strap path:
    // strap-top = upper joining seam of the front left strap; strap-bottom =
    // back strap/panel join. The back end seeds only inside the back-view branch
    // below; a front-only sketch has no back end, so POM 14 → REVIEW_ONLY.

    // POM 6 rescue: when the direct CF-seam detector missed (no cradleCfTop)
    // but the bottom-cup cradle seam WAS found (cradleCupTop — the POM 7 top),
    // extend that detected seam horizontally to the CF axis as an APPROXIMATE
    // POM 6 top. It seeds low-confidence + reviewRequired (see confByKind /
    // sourceByKind below) so the TD still verifies; this only replaces a hard
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
    const goreBottomYFromContours = () => {
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
    };
    const detCradleCfY = detection.cradleCfTop ? detection.cradleCfTop.y : null;
    const goreBottom = goreBottomYFromContours();
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

    // Landmark QA layer (Engineering Workflow Phase 6): the per-landmark
    // verdicts — source class, confidence tier, reviewRequired, QA notes —
    // that this seed layer consumes below instead of recomputing its own
    // tables. Computed HERE (not reused from detection time) because the
    // detection object can be mutated between seedings (e.g. the front_inner
    // branch backfills detection.innerCupTop), and it must run BEFORE that
    // mutation so its evidence reads match this seeding pass — and AFTER the
    // crest-tier decision above, which it classifies via
    // detection.cradleCfCrestSeedY. Re-attached so debug consumers always see
    // the verdicts the current anchors came from.
    const landmarkQa = buildLandmarkQaFromDetection(detection);
    if (landmarkQa) detection.landmarkQa = landmarkQa;
    const qaByKind = (landmarkQa && landmarkQa.byKind) || {};

    let seeds = {
      'cf-top':         { x: ax, y: clamp01(top + bb.height * 0.04) },
      'cf-bottom':      { x: ax, y: clamp01(band) },
      // cradle-cf-top: seeded from direct CF-seam detection when present;
      // else from the contour crest tier (US-015 / ADR 0023, review-flagged);
      // else from the POM 7 cradle seam projected to the CF axis (the
      // cradleCfFromCupSeam rescue). Missing ALL means POM 6 stays REVIEW_ONLY.
      ...(detection.cradleCfTop
        ? { 'cradle-cf-top': {
            x: clamp01(detection.cradleCfTop.x),
            y: clamp01(cradleCfTopY != null ? cradleCfTopY : detection.cradleCfTop.y),
          } }
        : (cradleCfCrestY != null
          ? { 'cradle-cf-top': {
              x: clamp01(ax),
              y: clamp01(cradleCfCrestY),
            } }
          : (cradleCfFromCupSeam
            ? { 'cradle-cf-top': {
                x: clamp01(ax),
                y: clamp01(detection.cradleCupTop.y),
              } }
            : {}))),
      // cradle-cup-top / -bottom: seeded ONLY when the bottom-cup detector
      // found ink support both at the cradle row and the band row (away from
      // CF and side seam). No horizontal-ratio fallback — missing means POM 7
      // demotes to REVIEW_ONLY via the missing-anchor guard.
      ...(detection.cradleCupTop && detection.cradleCupBottom
        ? {
            'cradle-cup-top': {
              x: clamp01(detection.cradleCupTop.x),
              y: clamp01(detection.cradleCupTop.y),
            },
            'cradle-cup-bottom': {
              x: clamp01(detection.cradleCupBottom.x),
              y: clamp01(detection.cradleCupBottom.y),
            },
          }
        : {}),
      'band-left':      { x: clamp01(left),  y: clamp01(band) },
      'band-right':     { x: clamp01(right), y: clamp01(band) },
      'chest-left':     { x: clamp01(left),  y: clamp01(chest) },
      'chest-right':    { x: clamp01(right), y: clamp01(chest) },
      'inner-cup-top':    { x: clamp01(icX), y: clamp01(chest + (band - chest) * 0.10) },
      'inner-cup-bottom': { x: clamp01(icX + icSide * halfW * 0.02), y: clamp01(cradle) },
      'inner-cup-left':   { x: clamp01(icX - icHalf), y: clamp01(cupMid) },
      'inner-cup-right':  { x: clamp01(icX + icHalf), y: clamp01(cupMid) },
      'side-top':       { x: clamp01(sideR), y: clamp01(chest) },
      'side-bottom':    { x: clamp01(sideR), y: clamp01(band) },
      'back-top':       { x: clamp01(sideL), y: clamp01(chest) },
      'back-bottom':    { x: clamp01(sideL), y: clamp01(band) },
    };

    // Prefer ink-derived inner-cup top / side-top from the audit-driven
    // detectors. Each helper returns null when the signal is too weak, so
    // formula-based fallbacks below still apply.
    //
    // Per rule.md POM 9/10: the inner-cup anchors must come from the shared
    // cupModel (one side, one view, derived from real structure) — NOT from
    // a "topmost dark pixel" snap. cupModel is preferred wherever it is
    // present and not 'hidden'. The legacy innerCupTopInk is kept only as a
    // last-resort fallback for sketches where the cupModel can't be built
    // (e.g. apex + cradle-cup both missing) AND the front_inner view branch
    // below isn't used either.
    const cupModel = detection.cupModel || null;
    const innerCupTopInk = detection.innerCupTop || null;
    const sideTopRightInk = detection.sideTopRight || null;
    const sideTopLeftInk  = detection.sideTopLeft  || null;
    const backPanelInk = detection.backPanel || null;
    const backPanelHeightInk = detection.backPanelHeight || null;

    // POM 9/10 inner-cup endpoints from the shared cupModel, in source-image
    // [0,1] space. Returns null when the model isn't usable (hidden or missing
    // an endpoint) so callers fall back to their own heuristics. inner-cup-left
    // always gets the smaller x so canvas geometry stays "left → right"
    // regardless of which cup side the model picked. Single source of truth for
    // both the frontView and frontInnerView branches below.
    const innerCupFromCupModel = (cm) => {
      // innerEdgeSupported === false: the model's width row crosses a void
      // (open neckline V) and the inner endpoint is a fabricated gore inset
      // with no ink near it — fall down the precedence chain instead of
      // anchoring POM 9/10 in blank space. Mirrors cupModelUsable in
      // landmark-qa.js (the authoritative gate predicate).
      if (!(cm && cm.visibility !== 'hidden'
            && cm.innerEdgeSupported !== false
            && cm.topPoint && cm.bottomPoint
            && cm.innerEdge && cm.outerEdgeNearArmhole)) {
        return null;
      }
      const a = cm.innerEdge;
      const b = cm.outerEdgeNearArmhole;
      const leftPt  = a.x <= b.x ? a : b;
      const rightPt = a.x <= b.x ? b : a;
      return {
        top:    { x: clamp01(cm.topPoint.x),    y: clamp01(cm.topPoint.y) },
        bottom: { x: clamp01(cm.bottomPoint.x), y: clamp01(cm.bottomPoint.y) },
        left:   { x: clamp01(leftPt.x),  y: clamp01(leftPt.y) },
        right:  { x: clamp01(rightPt.x), y: clamp01(rightPt.y) },
      };
    };

    // Contour-based cup INNER seam (POM 10 width). buildCupModel runs BEFORE the
    // vector trace, so its innerEdge is a pixel guess that a solid center-gore
    // detail (CF seam, bow) can pull toward the CF axis — leaving the endpoint
    // floating in the gore instead of on the cup. detection.contours is traced
    // by the time we seed, so use the cup panel's outline: its edge nearest the
    // axis is the true inner seam. Returns the seam x (normalized) or null.
    const cupInnerSeamFromContours = (cm) => {
      const C = detection.contours;
      if (!C || !Array.isArray(C.paths) || !cm) return null;
      const side = cm.side;
      const axisX = detection.axisX;
      if (axisX == null) return null;
      const rowY = cm.innerEdge ? cm.innerEdge.y : (cm.centerPoint ? cm.centerPoint.y : null);
      if (rowY == null) return null;
      const cupCenterX = cm.centerPoint ? cm.centerPoint.x
        : (cm.outerEdgeNearArmhole ? (axisX + cm.outerEdgeNearArmhole.x) / 2 : null);
      if (cupCenterX == null) return null;
      const fv = frontView;
      const viewW = fv ? fv.width : 1;
      const viewH = fv ? fv.height : 1;
      // Pick the largest cup-side panel contour that spans the width row.
      let best = null;
      for (const p of C.paths) {
        const b = p && p.bbox; if (!b) continue;
        const bMinX = b.x, bMaxX = b.x + b.width, bMinY = b.y, bMaxY = b.y + b.height;
        const cx = (bMinX + bMaxX) / 2;
        if (side < 0 ? cx >= axisX : cx <= axisX) continue;        // cup side only
        if (b.width > viewW * 0.6) continue;                       // not the whole outline
        if (b.height < viewH * 0.20) continue;                     // a real cup panel
        if (rowY < bMinY - 0.02 || rowY > bMaxY + 0.02) continue;  // spans the width row
        const area = b.width * b.height;
        if (!best || area > best.area) best = { area, path: p };
      }
      if (!best) return null;
      // Sample the panel outline and take where it ACTUALLY crosses y = rowY.
      // The bbox horizontal extreme (bMaxX/bMinX) sits at the panel's widest
      // row — the apex, not rowY — so using it floated the endpoint ~17px
      // off-ink and inflated cup width (~+7.5% on demo5). The inner seam is the
      // crossing nearest the CF axis, on the cup side, off-axis. A crossing at
      // rowY is by construction on the traced ink, so this doubles as the
      // "must lie on ink at rowY" gate: no valid crossing → null → fall back.
      const samples = samplePathPoints(best.path);
      const n = samples.length;
      if (n < 2) return null;
      let innerX = null;
      for (let i = 0; i < n; i += 1) {
        const a = samples[i];
        const c = samples[(i + 1) % n];         // closed contour: wrap to start
        const da = a.y - rowY, dc = c.y - rowY;
        if ((da > 0 && dc > 0) || (da < 0 && dc < 0)) continue;  // no crossing
        if (a.y === c.y) continue;                               // horizontal seg
        const t = da / (a.y - c.y);             // = (rowY - a.y) / (c.y - a.y)
        const x = a.x + t * (c.x - a.x);
        // Keep only crossings between the cup center and just inside the axis.
        const ok = side < 0
          ? (x > cupCenterX && x < axisX - 0.005)
          : (x < cupCenterX && x > axisX + 0.005);
        if (!ok) continue;
        // Inner seam = the crossing nearest the CF axis on the cup side.
        if (innerX == null) innerX = x;
        else innerX = side < 0 ? Math.max(innerX, x) : Math.min(innerX, x);
      }
      return innerX == null ? null : clamp01(innerX);
    };

    // Pull POM 10's inner endpoint onto the contour-detected cup inner seam,
    // then re-clamp the POM 9 bottom to stay between the endpoints (A5).
    // The cup-panel contour edge IS the cup↔gore inner seam, so trust it over
    // the cupModel's pre-trace pixel guess in EITHER direction: the guess can
    // land too close to the CF axis (a solid gore detail pulling it in) OR too
    // far INTO the cup (a fixed gore inset that falls short of the real seam,
    // e.g. a molded/seamed bra with a distinct cup panel). The only constraint
    // is that the inner endpoint stays ordered against the outer endpoint;
    // cupInnerSeamFromContours already keeps seamX between the cup center and
    // just inside the CF axis, so it can't collide with the gore or cross over.
    const applyContourInnerSeam = (pts, cm) => {
      if (!pts || !cm) return pts;
      const seamX = cupInnerSeamFromContours(cm);
      if (seamX == null) return pts;
      let { top, bottom, left, right } = pts;
      if (cm.side < 0) {
        // left cup: inner endpoint = right (nearer the CF axis)
        if (seamX > left.x) right = { x: clamp01(seamX), y: right.y };
      } else {
        // right cup: inner endpoint = left (nearer the CF axis)
        if (seamX < right.x) left = { x: clamp01(seamX), y: left.y };
      }
      const lo = Math.min(left.x, right.x), hi = Math.max(left.x, right.x);
      bottom = { x: clamp01(Math.max(lo, Math.min(hi, bottom.x))), y: bottom.y };
      return { top, bottom, left, right };
    };

    if (frontView && frontView.width > 0 && frontView.height > 0) {
      const f = frontView;
      // Prefer ink-derived endpoints (chest L/R, band L/R, CF top) from the
      // detection pass; fall back to view-box ratios when the walker didn't
      // find ink. Ratios come from bra technical-sketch geometry — they map
      // a fitted view box to landmarks a TD usually expects.
      // In a typical flat technical sketch the POM 3 "chest line" is drawn at
      // the cup-bottom seam (underbust ridge), not at the strap-zigzag row.
      // The underbust seam is detected separately via longest-run scoring so
      // dense lace bands don't beat it. Prefer it whenever the detector found
      // a confident seam; fall back to the upper chest row otherwise.
      const chestSeedY = detection.underbustY != null
        ? detection.underbustY
        : (detection.chestY != null ? detection.chestY : (f.y + f.height * 0.615));
      const chestSeedLeftX = detection.underbustLeftX != null
        ? detection.underbustLeftX
        : (detection.chestLeftX != null ? detection.chestLeftX : null);
      const chestSeedRightX = detection.underbustRightX != null
        ? detection.underbustRightX
        : (detection.chestRightX != null ? detection.chestRightX : null);
      const bandYf  = detection.bandY  != null ? detection.bandY  : (f.y + f.height * 0.978);
      const useChestL = chestSeedLeftX  != null ? { x: chestSeedLeftX,  y: chestSeedY } : inView(f, 0.004, 0.615);
      const useChestR = chestSeedRightX != null ? { x: chestSeedRightX, y: chestSeedY } : inView(f, 0.990, 0.605);
      const useBandL  = detection.bandLeftX   != null ? { x: detection.bandLeftX,   y: bandYf  } : inView(f, 0.063, 0.978);
      const useBandR  = detection.bandRightX  != null ? { x: detection.bandRightX,  y: bandYf  } : inView(f, 0.936, 0.978);
      const useCfTop  = detection.cfTopY      != null ? { x: detection.axisX,       y: detection.cfTopY }
                                                      : inView(f, 0.505, 0.485);
      // POM 9 / POM 10 inner-cup anchors. Rule.md requires both to belong to
      // ONE cup model — same side, same view, real structure evidence (apex
      // + cup-bottom seam). The cupModel built upstream encodes that decision.
      // Source order:
      //   1. cupModel.topPoint / bottomPoint / innerEdge / outerEdge — when
      //      the cup model is usable (direct or inferred visibility).
      //   2. legacy innerCupTopInk only as a last resort. This path is a
      //      first-dark-pixel snap and rule.md says to replace it; we keep it
      //      so styles where no apex/seam fires but ink still suggests a cup
      //      arc don't lose the row entirely.
      //   3. view-box ratio fallback as the final fallback.
      // When the cupModel is 'hidden' AND no innerCupTopInk fires, we leave
      // the seed at the top-level formula default so the requiredAnchors
      // guard demotes POM 9/10 to REVIEW_ONLY (POM 9/10 anchors will then
      // pass the check, but the line itself would be a ratio guess — the
      // guard runs in auto-drafts.js on missing anchors only).
      // Note: when the cupModel uses the RIGHT cup, innerEdge sits to the
      // right of the CF axis and outerEdgeNearArmhole sits to the left of
      // the right side seam. We always assign inner-cup-left = the SMALLER x
      // of the two endpoints so the geometry stays "left horizontal end →
      // right horizontal end" in canvas space, regardless of which cup side
      // the model picked.
      // Adaptive best-guess for the fallbacks: when the cupModel can't be
      // built, POM 10 width must still track the real sketch, not a constant
      // fraction of the view box. The CF axis (axisX → gore/inner edge) and the
      // detected side seams (sideL/sideR → outer edge) are per-sketch signals,
      // so span the chosen cup between them. This replaces the old fixed
      // inView(f, 0.022/0.496, …) ratios that produced the same wrong width on
      // every sketch. inner-cup-left always takes the smaller x so canvas
      // geometry stays "left → right" regardless of the picked cup side.
      const axSafe = (ax != null && Number.isFinite(ax)) ? ax : clamp01(left + halfW);
      const landmarkInnerCupWidth = (cupIsLeft, widthY) => {
        const seamX = cupIsLeft ? sideL : sideR;
        const axisPad = Math.max(0.005, halfW * 0.03); // keep off the CF gore
        const seamPad = Math.max(0.004, halfW * 0.02); // keep off the side seam
        const innerX = cupIsLeft ? clamp01(axSafe - axisPad) : clamp01(axSafe + axisPad);
        const outerX = cupIsLeft ? clamp01(seamX + seamPad) : clamp01(seamX - seamPad);
        return {
          left:  { x: Math.min(innerX, outerX), y: clamp01(widthY) },
          right: { x: Math.max(innerX, outerX), y: clamp01(widthY) },
          centerX: clamp01((axSafe + seamX) / 2),
        };
      };
      let useIcTop, useIcBottomFromCup, useIcLeft, useIcRight;
      const frontCupPts = applyContourInnerSeam(innerCupFromCupModel(cupModel), cupModel);
      if (frontCupPts) {
        // POM 9/10 endpoints from the shared cup model — see
        // innerCupFromCupModel. POM 10 cup width spans the cup's FULL
        // horizontal extent (innerEdge just inside CF gore ↔ outerEdge just
        // inside the side seam); inner-cup-left always takes the smaller x so
        // canvas geometry stays "left → right" regardless of the picked side.
        useIcTop = frontCupPts.top;
        useIcBottomFromCup = frontCupPts.bottom;
        useIcLeft = frontCupPts.left;
        useIcRight = frontCupPts.right;
      } else if (innerCupTopInk) {
        // Legacy fallback — the cupModel could not be built (or its inner edge
        // is unsupported) but ink suggests a cup top. Anchor POM 9 on the
        // detected ink top (x shared top→bottom so the height reads vertical,
        // bottom on the detected cradle row) and derive POM 10 width from the
        // CF axis + side seam. The cup SIDE honors the cupModel's pick when a
        // model exists — invariants B1/B2 judge the anchors against
        // cupModel.side, and the ink top often sits ON the gore (≈ the axis),
        // making its own left/right tie-break arbitrary. The shared POM 9
        // column is clamped into the POM 10 span so A5/B1 hold even when the
        // gore-top ink lands a hair past the axis.
        const inkX = clamp01(innerCupTopInk.x);
        const cupIsLeft = (cupModel && (cupModel.side === -1 || cupModel.side === 1))
          ? cupModel.side < 0
          : inkX <= axSafe;
        const widthY = clamp01(innerCupTopInk.y + Math.max(0.05, (band - innerCupTopInk.y) * 0.45));
        const w = landmarkInnerCupWidth(cupIsLeft, widthY);
        const colX = Math.min(Math.max(inkX, w.left.x), w.right.x);
        useIcTop = { x: colX, y: clamp01(innerCupTopInk.y) };
        useIcLeft  = w.left;
        useIcRight = w.right;
        useIcBottomFromCup = { x: colX, y: clamp01(cradle) };
      } else {
        // Pure fallback — no cupModel and no ink top. Still avoid fixed view
        // ratios: estimate the cup from detected landmarks (CF axis, side
        // seams, chest/cradle) on the default cup side so the guess shifts per
        // sketch. This seed is usually deleted (REVIEW_ONLY) for a lone front
        // view or overwritten by the front_inner branch; kept adaptive for the
        // remaining cases and older detections without a cupModel field.
        const cupIsLeft = icSide < 0;
        const midY = clamp01((chest + cradle) / 2);
        const w = landmarkInnerCupWidth(cupIsLeft, midY);
        useIcTop = { x: w.centerX, y: clamp01(chest) };
        useIcLeft  = w.left;
        useIcRight = w.right;
        useIcBottomFromCup = { x: w.centerX, y: clamp01(cradle) };
      }
      // Side-top: underarm notch detected by walking up from the side-seam
      // column. Falls back to chest-line height on the side seam.
      const useSideTop = sideTopRightInk
        ? { x: clamp01(sideTopRightInk.x), y: clamp01(sideTopRightInk.y) }
        : { x: clamp01(sideR), y: clamp01(chest) };
      const useSideBot = detection.sideBottomRight
        ? { x: clamp01(detection.sideBottomRight.x), y: clamp01(detection.sideBottomRight.y) }
        : { x: clamp01(sideR), y: clamp01(band) };
      // POM 16 = apex distance across the cup/front-strap joining seams,
      // measured inner-edge to inner-edge — prefer the inner-edge points,
      // falling back to the join center when the detector only has that.
      const apexLsrc = detection.apexLeftInner || detection.apexLeft;
      const apexRsrc = detection.apexRightInner || detection.apexRight;
      const useApexL = apexLsrc
        ? { x: clamp01(apexLsrc.x), y: clamp01(apexLsrc.y) }
        : null;
      const useApexR = apexRsrc
        ? { x: clamp01(apexRsrc.x), y: clamp01(apexRsrc.y) }
        : null;
      // Front endpoint of POM 14 (ADR 0016/0017): the strap JOIN on the RIGHT
      // shoulder strap — the strap adjacent to the back view, so the drawn
      // curve follows one continuous strap. With a stitched strap section the
      // join is that section's top seam (frontStrapStart); on plain straps
      // there is no such seam, and the join is where the strap attaches to the
      // cup/neckline — the validated cup/strap join, on its OUTER edge (the
      // apex-inner variant belongs to POM 16). Never the strap's top cut edge
      // (TD corrections 2026-07-10: "front strap join, not front strap top";
      // "outer edge of front strap join, not inner edge").
      const strapJoin = detection.apexRightOuter || detection.apexLeftOuter
        || (useApexR || useApexL);
      const useFrontStrapTop = detection.frontStrapStart
        ? { x: clamp01(detection.frontStrapStart.x), y: clamp01(detection.frontStrapStart.y) }
        : (strapJoin
          ? { x: clamp01(strapJoin.x), y: clamp01(strapJoin.y) }
          : inView(f, 0.80, 0.18));

      // POM 17 / 18 (US-037, ADR 0032) — neckline width + armhole curve,
      // both on front_outer.
      //   POM 17 "Neckline length" (TD 2026-07-18): the neckline edge measured
      //   from CENTER FRONT to the strap on one side — NOT a symmetric width.
      //     171 = center-front neckline point = cf-top (top of the CF placket
      //           / gore, on the axis).
      //     172 = where the neckline meets the RIGHT strap = the cup↔strap
      //           JOINING SEAM on the inner side.
      // TD 2026-07-18: 172 and 182 must sit at the strap→cup JOINING SEAM, not
      // up the strap. apex* give the correct inner/outer X but their Y lands at
      // the cup apex / strap TOP (too high). detection.strapBottom lands LOW —
      // at the princess-seam convergence INSIDE the cup (too low). The visual
      // join is between them, ~1/3 of the way from apex down toward strapBottom
      // (demo5: apex 0.19 too high, strapBottom 0.42 too low, join ≈ 0.27).
      // Interpolate rather than snap. When frontStrapStart is detected it
      // already sits at the join, so it is used as-is.
      const STRAP_JOIN_FRAC = 0.35;
      const strapJoinY = (srcY) => (detection.strapBottom
        && typeof detection.strapBottom.y === 'number'
        && detection.strapBottom.y > srcY)
        ? srcY + (detection.strapBottom.y - srcY) * STRAP_JOIN_FRAC : srcY;
      const useNecklineCenter = (detection.cfTopY != null && detection.axisX != null)
        ? { x: clamp01(detection.axisX), y: clamp01(detection.cfTopY) }
        : inView(f, 0.50, 0.55);
      const necklineStrapSrc = detection.apexRightInner || detection.apexRight;
      const useNecklineStrap = necklineStrapSrc
        ? { x: clamp01(necklineStrapSrc.x), y: clamp01(strapJoinY(necklineStrapSrc.y)) }
        : inView(f, 0.66, 0.28);
      //   Armhole (RIGHT side, matching POM 14's right-strap convention).
      //   TD 2026-07-18: the two anchors must SPAN the arm opening —
      //     182 = TOP of the opening = strap/shoulder junction at the chest
      //           line (the right cup↔strap outer join).
      //     181 = BOTTOM of the opening = the underarm / side point, well
      //           BELOW the chest row on the outer side edge.
      //   (An earlier build clustered both up at the strap because the
      //   "bottom" used the chest row for its y; the underarm is much lower.)
      // Mirror 172 exactly: outer X from apexRightOuter (or frontStrapStart /
      // strapJoin as fallback), Y always dropped to the join via strapJoinY.
      // frontStrapStart is NOT used as-is — it lands up at the strap top, which
      // put 182 above 172 on sketches where it was detected (demo1/demo4/
      // amorafit); routing it through strapJoinY keeps 172 and 182 level at the
      // joining seam (TD 2026-07-18).
      const armhole182Src = detection.apexRightOuter || detection.frontStrapStart || strapJoin;
      const useArmhole182Top = armhole182Src
        ? { x: clamp01(armhole182Src.x), y: clamp01(strapJoinY(armhole182Src.y)) }
        : inView(f, 0.86, 0.16);
      // Underarm (181): the BOTTOM of the arm opening, on the OUTER silhouette
      // where the armhole meets the side seam. Priority:
      //   1. detected side-seam-top ink notch (the true underarm), when present.
      //   2. chest-right — it sits on the outer silhouette at bust height, which
      //      is where the armhole runs into the side; `sideRightX` alone lands
      //      too far IN (near the gore) on molded cups (TD 2026-07-18, demo5).
      //   3. side column, partway DOWN from the strap junction toward the cradle.
      // Pick whichever candidate is the most OUTER (largest x) so the anchor
      // reaches the arm edge rather than the center.
      let useArmhole181Bot;
      if (detection.sideTopRightInk) {
        useArmhole181Bot = { x: clamp01(detection.sideTopRightInk.x),
                             y: clamp01(detection.sideTopRightInk.y) };
      } else {
        const downRef = detection.cradleY != null ? detection.cradleY : cradle;
        const colY = useArmhole182Top.y + (downRef - useArmhole182Top.y) * 0.45;
        const colX = detection.sideRightX != null ? detection.sideRightX : sideR;
        const chestOuter = useChestR && useChestR.x > colX ? useChestR : null;
        useArmhole181Bot = chestOuter
          ? { x: clamp01(chestOuter.x), y: clamp01(chestOuter.y) }
          : { x: clamp01(colX), y: clamp01(colY) };
      }
      // CF-bottom: bandY is the highest-confidence horizontal signal in the
      // pipeline. Prefer (axisX, bandY) over the view-box fraction so POMs 5
      // and 6 land on the actual band ink.
      const useCfBottom = (detection.bandY != null && detection.axisX != null)
        ? { x: clamp01(detection.axisX), y: clamp01(detection.bandY) }
        : inView(f, 0.505, 0.985);
      // Inner-cup-bottom: cradleY is the clean horizontal contour between
      // chest and band. When the cupModel is usable, its bottomPoint already
      // sits on the selected cup side at the cup-bottom seam — share x with
      // POM 9 (cupModel.topPoint or seam x), not the CF axis. Falls back to
      // (axisX, cradleY) when the cupModel is hidden so existing dependents
      // (POM 6 cup-bottom projection) keep their behavior.
      const useIcBottom = useIcBottomFromCup
        ? useIcBottomFromCup
        : ((detection.cradleY != null && detection.axisX != null)
          ? { x: clamp01(detection.axisX), y: clamp01(detection.cradleY) }
          : inView(f, 0.227, 0.888));
      seeds = {
        ...seeds,
        'cf-top':          useCfTop,
        'cf-bottom':       useCfBottom,
        'band-left':       useBandL,
        'band-right':      useBandR,
        'chest-left':      useChestL,
        'chest-right':     useChestR,
        'inner-cup-top':   useIcTop,
        'inner-cup-bottom':useIcBottom,
        'inner-cup-left':  useIcLeft,
        'inner-cup-right': useIcRight,
        'side-top':        useSideTop,
        'side-bottom':     useSideBot,
        'strap-top':       useFrontStrapTop,
        '171':   useNecklineCenter,
        '172':  useNecklineStrap,
        '181':  useArmhole181Bot,
        '182':  useArmhole182Top,
      };
      roleByKind['strap-top'] = 'front_outer';
      roleByKind['171'] = 'front_outer';
      roleByKind['172'] = 'front_outer';
      roleByKind['181'] = 'front_outer';
      roleByKind['182'] = 'front_outer';
      if (useApexL && useApexR) {
        seeds['apex-left'] = useApexL;
        seeds['apex-right'] = useApexR;
      }
      // A4: side-top/side-bottom default to viewRole 'back', and the back branch
      // re-seeds them from back-view coordinates and leaves that role correct.
      // But on a FRONT-ONLY sketch the back branch never runs, so these anchors
      // carry the FRONT coordinates seeded just above while still labelled
      // 'back' — which mislabels their view (POM 11) and, worse, files their
      // learning residuals in the side-*|back bucket where they collide with
      // genuine back-view corrections. Tag them to the view they came from.
      if (!backView) {
        roleByKind['side-top'] = 'front_outer';
        roleByKind['side-bottom'] = 'front_outer';
      }
    }

    if (frontInnerView && frontInnerView.width > 0 && frontInnerView.height > 0) {
      const i = frontInnerView;
      const innerBandY = i.y + i.height * 0.92;
      const innerChestY = i.y + i.height * 0.22;
      const innerCupMidY = i.y + i.height * 0.54;
      // Front-inner view is the cup model's preferred source per rule.md
      // ("Prefer front_inner view if it exists and the cup is clearly
      // visible"). When a front_inner view exists buildCupModel classifies
      // visibility as 'direct' and produces ink-derived endpoints — those track
      // the actual cup and differ per sketch, so we MUST prefer them over the
      // view-box ratios (which depend only on the view box and are constant
      // across sketches). Precedence: cupModel > innerCupTopInk (kept as-is
      // from the frontView branch — do not clobber) > view-box ratio fallback.
      // Computed here rather than reused from the frontView branch because a
      // sketch can have a front_inner view without a front_outer view, so that
      // branch may not have run. The role override below tells the rest of the
      // pipeline these anchors belong to the front_inner view regardless of
      // which source produced their coordinates.
      const innerCupPts = applyContourInnerSeam(innerCupFromCupModel(cupModel), cupModel);
      if (innerCupPts) {
        seeds = {
          ...seeds,
          'inner-cup-top':    innerCupPts.top,
          'inner-cup-bottom': innerCupPts.bottom,
          'inner-cup-left':   innerCupPts.left,
          'inner-cup-right':  innerCupPts.right,
        };
      } else if (!innerCupTopInk) {
        // No usable cup model and no ink heuristic — fall back to view-box
        // ratios. The view box isolates the inner cup, so these still land on
        // cup structure (a legitimate direct-view guess, not fabrication).
        seeds = {
          ...seeds,
          'inner-cup-top':    inView(i, 0.50, 0.18),
          'inner-cup-bottom': inView(i, 0.50, 0.82),
          'inner-cup-left':   inView(i, 0.20, 0.53),
          'inner-cup-right':  inView(i, 0.80, 0.53),
        };
      }
      // else: innerCupTopInk fired but the cupModel is hidden — keep the
      // innerCupTopInk-derived seeds the frontView branch already set (rule.md
      // legacy heuristic); do not overwrite them with view-box ratios.
      roleByKind['inner-cup-top'] = 'front_inner';
      roleByKind['inner-cup-bottom'] = 'front_inner';
      roleByKind['inner-cup-left'] = 'front_inner';
      roleByKind['inner-cup-right'] = 'front_inner';
      if (!detection.innerCupTop) {
        detection.innerCupTop = { x: i.x + i.width * 0.50, y: innerChestY };
      }
      if (detection.cradleY == null) detection.cradleY = innerBandY;
      if (detection.underbustY == null) detection.underbustY = innerCupMidY;
    }

    // Demote POM 9 / POM 10 to REVIEW_ONLY when no coherent cup model could
    // be built. The requiredAnchors guard in auto-drafts.js promotes a row to
    // REVIEW_ONLY when ANY required anchor is missing from the seed list, so
    // we remove the inner-cup-* seeds entirely in the "hidden + no fallback"
    // case (per rule.md "If REVIEW_ONLY, do not fabricate start/end from
    // fixed ratios"). When the front_inner view fires the seeds above are
    // direct evidence (not ratio fabrication) and we keep them. When the
    // legacy innerCupTopInk fires we keep them too — that's a heuristic but
    // it carries some structure information, and the existing flow has shown
    // it usable on a number of sketches.
    // Anchor-gate diagnostic — which source path POM 9/10 ended up using.
    // Computed by the landmark QA layer (single source of truth for the gate
    // predicate); surfaced via detection.debug.cupAnchorGate so debug
    // consumers (rule.md 'why was this row demoted?' question) can see the
    // gate decision without re-running detection.
    const cupAnchorGate = landmarkQa ? landmarkQa.cupGate : null;
    const anchorGateWillDelete = !!(cupAnchorGate && cupAnchorGate.willDelete);
    if (detection && detection.debug && typeof detection.debug === 'object') {
      detection.debug.cupAnchorGate = cupAnchorGate;
    }
    if (anchorGateWillDelete) {
      delete seeds['inner-cup-top'];
      delete seeds['inner-cup-bottom'];
      delete seeds['inner-cup-left'];
      delete seeds['inner-cup-right'];
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[Auto Mode] inner-cup-* anchors deleted → POM 9/10 demoted', cupAnchorGate);
      }
    }

    if (backView && backView.width > 0 && backView.height > 0) {
      const b = backView;
      // POM 12 (back center length) is a VERTICAL line down the center-back
      // axis. detection.back is the ink-based center pass on the back view.
      //   * bottom — the band row at center (detected). Correct as-is.
      //   * top    — the TOP of the center-back structure. Use the center-strip
      //              "topmost ink" landmark (backCenter.top.y): it sits ON solid
      //              center-back fabric (closure panel / mesh seam), so it never
      //              floats in an open racerback/scoop cut-out. (An earlier pass
      //              lifted this to chestY, but on open-center backs that row is
      //              empty and the anchor floated above the garment.)
      // Both endpoints share the axis x, so the line is always vertical.
      const backCenter = detection.back || null;
      const bfx = detection.backFeatures || null;
      const backBottom = backCenter && backCenter.bottom
        ? backCenter.bottom
        : inView(b, 0.505, 1.000);
      const backCenterAxisX = (backCenter && backCenter.axisX != null)
        ? backCenter.axisX
        : (bfx && bfx.axisX != null ? bfx.axisX : backBottom.x);
      const backTopY = (backCenter && backCenter.top && backCenter.top.y != null)
        ? backCenter.top.y
        : (bfx && bfx.chestY != null ? bfx.chestY : inView(b, 0.505, 0.769).y);
      const backTop = { x: backCenterAxisX, y: backTopY };
      const backBottomVert = { x: backCenterAxisX, y: backBottom.y };
      // Per-view back features — sideLeftX/RightX are the back's actual side
      // seams; chestY / chestLeftX / chestRightX trace the upper-back strap
      // line; bandY is the back's bottom band row.
      const bf = detection.backFeatures || null;
      const bChestY = bf && bf.chestY != null ? bf.chestY : (b.y + b.height * 0.42);
      const bBandY  = bf && bf.bandY  != null ? bf.bandY  : (b.y + b.height * 0.97);
      // The back-view "side seam" is the OUTLINE column of the back panel,
      // i.e. the left edge of the back view bbox. detectFeaturesInViewBox can
      // report an interior column with strong vertical ink (the panel-attach
      // seam) — that's wrong for POM 11. Use the back bbox left edge with a
      // tiny inset so the seam reads as snapped-to-ink rather than view-box.
      const bSideL  = b.x + b.width * 0.005;
      // POM 15 back-strap distance: prefer the ink-detected strap INNER edges.
      // Falls back to chestLeftX/chestRightX (panel OUTER corners) only when the
      // strap detector finds nothing, then to view-box ratios.
      const bStrapInner = detection.backStrapInner || null;
      const bStrapL = bStrapInner && bStrapInner.left
        ? { x: bStrapInner.left.x, y: bStrapInner.left.y }
        : (bf && bf.chestLeftX  != null ? { x: bf.chestLeftX,  y: bChestY } : inView(b, 0.276, 0.414));
      const bStrapR = bStrapInner && bStrapInner.right
        ? { x: bStrapInner.right.x, y: bStrapInner.right.y }
        : (bf && bf.chestRightX != null ? { x: bf.chestRightX, y: bChestY } : inView(b, 0.729, 0.426));
      // Back-panel top/bottom: prefer the ink-following detector. Falls back
      // to view-box ratios; the old inView(b, 0.232, 1.005) used to clamp the
      // bottom anchor off-image — keep the same fraction but clamp at 0.985
      // so the seed lives inside the box even on a partial back view.
      // POM 13 = strap-joining point → bottom band (vertical). Prefer the
      // dedicated height detector; fall back to the interior-seam-column edges,
      // then to view-box ratios.
      const usePanelTop = backPanelHeightInk && backPanelHeightInk.top
        ? { x: clamp01(backPanelHeightInk.top.x), y: clamp01(backPanelHeightInk.top.y) }
        : (backPanelInk && backPanelInk.top
          ? { x: clamp01(backPanelInk.top.x), y: clamp01(backPanelInk.top.y) }
          : inView(b, 0.225, 0.439));
      const usePanelBot = backPanelHeightInk && backPanelHeightInk.bottom
        ? { x: clamp01(backPanelHeightInk.bottom.x), y: clamp01(backPanelHeightInk.bottom.y) }
        : (backPanelInk && backPanelInk.bottom
          ? { x: clamp01(backPanelInk.bottom.x), y: clamp01(backPanelInk.bottom.y) }
          : inView(b, 0.232, 0.985));
      // POM 14's back endpoint is the strap/panel join. strap-top is seeded in
      // the front-view branch and must not be overwritten with back-view ink.
      const useBackStrapBottom = { x: usePanelTop.x, y: usePanelTop.y };
      // POM 11 side seam: follow the back panel's outer outline with ink.
      // side-top is the topmost edge ink; side-bottom follows that seam DOWN to
      // the hem. Real seams slant inward, so the old code (both pinned to the
      // bbox left edge at chest/band rows) drew a vertical line off the seam.
      const backSide = detection.backSide || null;
      const useBackSideTop = backSide && backSide.top
        ? { x: clamp01(backSide.top.x), y: clamp01(backSide.top.y) }
        : (detection.backSideTop
          ? { x: clamp01(detection.backSideTop.x), y: clamp01(detection.backSideTop.y) }
          : { x: clamp01(bSideL), y: clamp01(bChestY) });
      const useBackSideBottom = backSide && backSide.bottom
        ? { x: clamp01(backSide.bottom.x), y: clamp01(backSide.bottom.y) }
        : (detection.backSideBottom
          ? { x: clamp01(detection.backSideBottom.x), y: clamp01(detection.backSideBottom.y) }
          : { x: clamp01(bSideL), y: clamp01(bBandY) });
      seeds = {
        ...seeds,
        'side-top':          useBackSideTop,
        'side-bottom':       useBackSideBottom,
        'back-top':          { x: clamp01(backTop.x),        y: clamp01(backTop.y) },
        'back-bottom':       { x: clamp01(backBottomVert.x), y: clamp01(backBottomVert.y) },
        'back-panel-top':    usePanelTop,
        'back-panel-bottom': usePanelBot,
        'back-strap-left':   { x: clamp01(bStrapL.x), y: clamp01(bStrapL.y) },
        'back-strap-right':  { x: clamp01(bStrapR.x), y: clamp01(bStrapR.y) },
        'strap-bottom':      useBackStrapBottom,
      };
      // Only the ending strap anchor lives on the back view.
      roleByKind['strap-bottom'] = 'back';
    }

    // Anchor confidence, provenance, and reviewRequired come from the landmark
    // QA layer (Engineering Workflow Phase 6 — see buildLandmarkQaFromDetection
    // in src/auto/detect/landmark-qa.js, where the tier / provenance / review
    // predicates live with their full rationale). The seed layer places
    // coordinates; the QA layer says how much to trust each landmark and why.
    // The verdicts are the exact tables that used to live here, so anchors,
    // drafts, and golden output are unchanged.
    const cupId = (detection.cupModel && detection.cupModel.id) || null;

    const list = [];
    for (const schema of ANCHOR_SCHEMA) {
      const seed = seeds[schema.kind];
      if (!seed) continue;
      const qaEntry = qaByKind[schema.kind] || null;
      const source = qaEntry && qaEntry.source ? qaEntry.source : 'unknown';
      const confTier = qaEntry ? qaEntry.confidence : 'medium';
      // reviewRequired is the QA layer's weak-landmark verdict: ratio-only or
      // projected seeds, 'low' tiers, genuinely-inferred weak cup anchors, and
      // non-'high' anchors on a weak geometry frame. The drafter still
      // respects requiredAnchors for hard-gating; this flag lets the spec
      // panel (and contract tests) mark a drawn line as needing a second look
      // without forcing REVIEW_ONLY.
      const reviewRequired = qaEntry ? !!qaEntry.reviewRequired : false;
      const record = {
        id: createUniqueAnnotationId(),
        kind: schema.kind,
        name: schema.name,
        group: schema.group,
        x: seed.x,
        y: seed.y,
        sourceImageId: sourceImage.id,
        viewRole: roleByKind[schema.kind] || defaultViewRoleForAnchorKind(schema.kind),
        confidence: confTier,
        autoFilled: true,
        source,
        reviewRequired,
      };
      // Phase 6 provenance carried onto the anchor record: the landmark
      // source class (detected / derived / projected — 'learned' is applied
      // below when the learning loop moves the seed) and the QA notes that
      // explain any weakness in TD language.
      if (qaEntry) {
        record.landmarkSourceClass = qaEntry.sourceClass;
        if (Array.isArray(qaEntry.notes) && qaEntry.notes.length) {
          record.qaNotes = qaEntry.notes.slice();
        }
      }
      // Attach the shared cupModel id to inner-cup-* anchors so contract
      // tests can prove POM 9 and POM 10 read from the SAME cup model.
      if (cupId && schema.kind.indexOf('inner-cup-') === 0) {
        record.cupModelId = cupId;
      }
      list.push(record);
    }
    // Learning-loop hook: when enabled, nudge each seeded anchor by the
    // median (detected → corrected) residual recorded from past TD drags.
    // No-op when learning is off or a bucket has fewer than the minimum
    // samples. The geometric rules above are not changed.
    //
    // Phase 2 shadow runs pass { skipLearning: true } so the residual is
    // computed against the unbiased prediction, never against an already-
    // biased one (which would compound the error and make the median drift).
    if (options && options.skipLearning) return list;
    const biased = applyLearningBiasToAnchors(list);
    // Phase 6: an anchor the learning loop actually moved is 'learned' — the
    // seed position is no longer purely the detector's landmark. The fine
    // `source` provenance is untouched (it still says which detector path
    // produced the seed); only the source CLASS is re-tagged.
    for (const anchor of biased) {
      if (anchor && anchor.calibrated && anchor.landmarkSourceClass) {
        anchor.landmarkSourceClass = 'learned';
        anchor.qaNotes = (anchor.qaNotes || []).concat(
          'learned: seed nudged by the median residual of past TD corrections.'
        );
      }
    }
    return biased;
  }

  function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

  function findDetectionViewByRole(detection, role) {
    const views = Array.isArray(detection && detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection && detection.viewBoxes) ? detection.viewBoxes : []);
    return views.find(v => v && (v.viewRole === role || v.role === role)) || null;
  }

  function defaultViewRoleForAnchorKind(kind) {
    if (/^back-|^back$/.test(kind)) return 'back';
    if (kind === 'side-top' || kind === 'side-bottom') return 'back';
    if (kind === 'strap-bottom') return 'back';
    if (kind === 'strap-top') return 'front_outer';
    if (kind.indexOf('inner-cup-') === 0) return 'front_outer';
    return 'front_outer';
  }

  function resetAnchorsToDetection() {
    const detection = state.autoMode.detection;
    if (!detection) {
      showToast('Run Detect Sketch first.');
      return;
    }
    const sourceImage = getImageById(detection.sourceImageId) || pickAutoSourceImage();
    if (!sourceImage) {
      showToast('No source image for the current detection.');
      return;
    }
    state.autoMode.anchors = seedAnchorsFromDetection(detection, sourceImage);
    state.autoMode.anchorSelectedId = null;
    state.autoMode.anchorsHidden = false;
    state.autoMode.hiddenAnchorKinds = []; // US-038: fresh seed shows all
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Anchors reset from detection.');
  }
