// Detection-view resolution for the anchor seed pass: which view box is
// front_outer / back / front_inner, the formula-fallback landmark rows
// (chest / cradle / band / side seams) used when detection surfaced no ink,
// and the baseline `seeds` literal that the later branches overwrite.
// Source part for app.js. Run `npm run build` after editing.
//
// Everything downstream reads the context produced here:
// seed-cradle-cf.js (POM 6/8 gore geometry), seed-cup-width.js (POM 9/10 cup
// geometry), seed-front-view.js, seed-back-view.js, and the seed-anchors.js
// orchestrator all consume frontView / backView / frontInnerView and the
// chest / band / cradle / side-seam rows resolved below.

  function inView(view, rx, ry) {
    return {
      x: clamp01(view.x + view.width * rx),
      y: clamp01(view.y + view.height * ry),
    };
  }
  // x-only view-box fallback, for a landmark whose y must come from a SHARED
  // row rather than from this side's own ratio (see the band/chest seeds).
  function inViewX(view, rx) { return clamp01(view.x + view.width * rx); }

  function resolveSeedViewContext(detection) {
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
    // POM 6's bottom (shared with POM 5) sits on the hem at the CF column when
    // detection resolved one, else on the flat band row (US-061). Older saved
    // detections have no cfBottomHemY, so they keep the flat row.
    const cfBottomY = Number.isFinite(detection.cfBottomHemY)
      ? detection.cfBottomHemY
      : band;
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

    return {
      frontView, frontInnerView, backView, roleByKind,
      bb, left, right, top, halfW, ax, band, cfBottomY, chest, cradle, cupMid,
      sideL, sideR, icSide, icX, icHalf,
      cupModel, innerCupTopInk, sideTopRightInk, sideTopLeftInk,
      backPanelInk, backPanelHeightInk,
    };
  }

  // The baseline seed set: formula/fallback positions for every anchor kind,
  // plus the cradle-cf-top / cradle-cup-* seeds that depend on the CF cradle
  // analysis in seed-cradle-cf.js. The front-outer, front-inner, and back
  // branches overwrite whatever they can source from real ink.
  function buildBaselineAnchorSeeds(detection, seedCtx, cradleCfSeed) {
    const {
      bb, left, right, top, halfW, ax, band, cfBottomY, chest, cradle, cupMid,
      sideL, sideR, icSide, icX, icHalf,
    } = seedCtx;
    const { cradleCfFromCupSeam, cradleCfTopY, cradleCfCrestY } = cradleCfSeed;

    return {
      'cf-top':         { x: ax, y: clamp01(top + bb.height * 0.04) },
      // POM 6's bottom follows the hem at the CF column, not the flat band row
      // (US-061). detection.cfBottomHemY equals bandY on a straight hem, so
      // this is a no-op there; on an arched hem it keeps the anchor on the
      // artwork instead of floating below it.
      'cf-bottom':      { x: ax, y: clamp01(cfBottomY) },
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
  }
