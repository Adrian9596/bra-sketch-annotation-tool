// Cup model — the self-contained decision engine shared by POM 9 (inner cup
// height) and POM 10 (inner cup width). It picks ONE cup side and one view from
// positive structure evidence, classifies visibility (direct / inferred /
// hidden), and derives the cup's top / bottom / inner-edge / outer-edge / center
// endpoints under invariants A5 / A6 / B3 / B4.
//
// Reads the ink through the front-view finders in
// src/auto/detect/front-landmarks.js (findCupInnerSilhouettePx /
// findCupOuterSilhouettePx / findCupBottomFromInk / findCupWidthFromInk), so this
// part must load after that one. Its caller is
// src/auto/detect/landmark-stage.js.
// Source part for app.js. Run `npm run build` after editing.

  // POM 9 / POM 10 share one cup model so they describe the same physical cup.
  // The model selects ONE cup side (left or right) and one view, then derives
  // its top / bottom / inner-edge / outer-edge / center from real structure
  // signals (apex = cup-strap join, cradleCupTop = cup-bottom seam, side seam,
  // CF axis). It never snaps to the topmost dark pixel inside a broad strip.
  //
  // visibility (POMs 9/10 are the cup drawn on the FRONT/outer view; a front_inner
  // cutaway is a bonus, never a precondition — DETECTION_AND_MEASUREMENT_CONTRACT.md):
  //   - 'direct'   : cup read from real structure at both ends — a validated apex
  //                  AND a real cup-bottom (committed seam or traced arc), OR a
  //                  front_inner cutaway view exists
  //   - 'inferred' : endpoints placeable but one is only extrapolated (flat-cradle
  //                  bottom, or no real apex)
  //   - 'hidden'   : neither apex nor cup-bottom reference is reliable
  //
  // When visibility is 'hidden' the model still returns a stub (topPoint / etc
  // may be null) so the seeding layer can skip inner-cup-* anchors and POM 9/10
  // demote to REVIEW_ONLY via the requiredAnchors guard. No ratio fallback.
  function buildCupModel(ctx) {
    const {
      bounds, w, h, dark, axisPx, cradleY,
      apexLeft, apexLeftConf, apexRight, apexRightConf,
      cradleCupTop, cradleCupSide, cradleCupTier, cradleCupConfidence,
      sideLeftX, sideRightX,
      hasFrontInner,
    } = ctx;
    const { minX, maxX } = bounds;
    const bboxW = maxX - minX + 1;

    // -------- 1. Pick cup side from positive structure evidence -------------
    // Only trusted seam tiers may influence the cup side. 'guide'/'arc' tier
    // commits (ADR 0021/0022) are review-grade POM 7 evidence and must leave
    // the cupModel — including its side selection — byte-identical.
    const trustedSeamTier = cradleCupTier === 'strong' || cradleCupTier === 'seam';
    const seamSide = trustedSeamTier ? cradleCupSide : 0;
    let side = 0;
    let sideReason = '';
    const lConf = apexLeftConf || 0;
    const rConf = apexRightConf || 0;
    if (apexLeft && apexRight && Math.abs(lConf - rConf) < 0.08) {
      // Symmetric apex evidence — pick the side whose cup-bottom seam was
      // accepted by the POM 7 detector. Fall back to left when neither side
      // dominates.
      if (seamSide === +1) { side = +1; sideReason = 'symmetric apex pair; cup-bottom seam confirms right cup'; }
      else if (seamSide === -1) { side = -1; sideReason = 'symmetric apex pair; cup-bottom seam confirms left cup'; }
      else { side = -1; sideReason = 'symmetric apex pair without cup-bottom seam evidence; default left cup'; }
    } else if (lConf > 0 || rConf > 0) {
      side = lConf >= rConf ? -1 : +1;
      sideReason = `stronger ${side < 0 ? 'left' : 'right'} apex confidence (${lConf.toFixed(2)} vs ${rConf.toFixed(2)})`;
    } else if (seamSide === -1 || seamSide === +1) {
      side = seamSide;
      sideReason = `no apex; cup side taken from POM 7 cup-bottom seam (side=${side})`;
    } else {
      side = -1;
      sideReason = 'no apex and no cup-bottom seam evidence; default left cup';
    }

    // Cup columns (needed early so the cup-bottom ink trace in step 3 can scan
    // the cup's central band). The cup occupies [sideColPx .. axisPx] for a
    // left cup and [axisPx .. sideColPx] for right; the HEIGHT runs through the
    // vertical median cupCenterX.
    const sideColPx = side < 0
      ? (Number.isFinite(sideLeftX)  ? Math.round(sideLeftX  * w) : minX + Math.round(bboxW * 0.05))
      : (Number.isFinite(sideRightX) ? Math.round(sideRightX * w) : maxX - Math.round(bboxW * 0.05));
    const cupCenterXpx = Math.round((axisPx + sideColPx) / 2);
    const cupCenterX = cupCenterXpx / w;

    // -------- 2. View role and visibility ----------------------------------
    const viewRole = hasFrontInner ? 'front_inner' : 'front_outer';
    const apexPoint = side < 0 ? apexLeft : apexRight;
    const apexConf  = side < 0 ? lConf    : rConf;

    // -------- 3. Y references — apex row (cup top) and seam row (cup bottom)
    // We separate Y from X here: a "cup height" measurement must use a
    // SINGLE column for both endpoints — taking topPoint.x from apex and
    // bottomPoint.x from the POM 7 seam column produces a diagonal line that
    // is NOT what a TD reads as cup height. So we record y-only references
    // and project them onto the cup center column in step 7.
    let apexY = null;
    let topFromApex = false;
    if (apexPoint) {
      apexY = apexPoint.y;
      topFromApex = true;
    }

    let seamY = null;
    let bottomFromSeam = false;
    let bottomFromInk = false;      // cup-bottom confirmed by a traced ink arc
    let bottomInkSupport = 0;
    let seamRawX = null;        // raw seam column (debug only)
    if (cradleCupTop && cradleCupSide === side && trustedSeamTier) {
      // Only strong/pattern-3 seams may relocate the cup bottom. Guide-tier
      // (sparse dashed, ADR 0021) and arc-tier (traced underwire, ADR 0022)
      // commits are weak evidence drawn for TD review — letting them in here
      // is exactly what shifted inner-cup geometry and broke invariant B3 in
      // the reverted 2026-07-09 prototype.
      seamY = cradleCupTop.y;
      seamRawX = cradleCupTop.x;
      bottomFromSeam = true;
    } else if (cradleY != null) {
      // POM 7 didn't commit a column on this side. Before falling back to the
      // flat global cradle row, try to CONFIRM the cup's own underwire bottom
      // as a coherent ink arc under the cup center (rule.md: "POM 7 can help
      // locate the lower cup reference, but only when POM 7 confidence is
      // reliable" — here we earn our own reliability). The trace is kept near
      // the cradle row (±0.05), so this refines/validates rather than relocates
      // the bottom, but converts an unearned guess into a trusted endpoint.
      const inkBottom = (apexY != null)
        ? findCupBottomFromInk(dark, w, h, bounds, axisPx, sideColPx, apexY, cradleY, side)
        : null;
      if (inkBottom
          && inkBottom.support >= 0.30
          && inkBottom.bottomY > apexY + 0.08
          && inkBottom.bottomY >= cradleY - 0.05) {
        seamY = clamp01(inkBottom.bottomY);
        bottomFromInk = true;
        bottomInkSupport = inkBottom.support;
      } else {
        seamY = cradleY;
      }
      bottomFromSeam = false;
    }

    // -------- 4. Visibility classification ---------------------------------
    // 'direct' still requires SOMETHING to anchor Y — front_inner alone with
    // no apex AND no cradle reference cannot place real endpoints, so it
    // falls through to 'hidden' rather than build geometry from null y's.
    // A cup is read DIRECTLY when it rests on real drawn structure at both ends —
    // a validated apex (cup top) AND a real cup-bottom (a committed POM 7 seam or a
    // traced underwire arc) — regardless of whether a separate front_inner cutaway
    // view exists. Per the 2026-07-09 TD correction (DETECTION_AND_MEASUREMENT_CONTRACT.md
    // Part 1 "Cup group"), POMs 9/10 are the cup as drawn on the FRONT (outer) view;
    // a front_inner cutaway is a bonus, never a precondition. 'inferred' is the
    // genuinely weaker case: endpoints are placeable but one is only extrapolated —
    // a bare flat-cradle-row bottom, or no real apex. 'hidden' = endpoints unplaceable.
    const bottomReal = bottomFromSeam || bottomFromInk;
    let visibility;
    let visibilityReason;
    if ((topFromApex && bottomReal) || (hasFrontInner && (apexY != null || seamY != null))) {
      visibility = 'direct';
      visibilityReason = hasFrontInner
        ? 'front_inner view detected; inner cup is drawn directly'
        : (bottomFromSeam
          ? 'front cup read directly: apex (cup top) + committed cup-bottom seam'
          : 'front cup read directly: apex (cup top) + traced cup-bottom underwire arc');
    } else if (apexY != null && seamY != null) {
      visibility = 'inferred';
      visibilityReason = topFromApex
        ? 'apex anchors the cup top; cup bottom only inferred from the flat cradle row'
        : 'cup top not on a real apex; endpoints partially inferred';
    } else {
      visibility = 'hidden';
      visibilityReason = hasFrontInner
        ? 'front_inner view present but no apex and no cup-bottom reference — cannot anchor endpoints'
        : 'no apex AND no cup-bottom reference — cup model cannot be located';
    }

    // POM 9/10 silent-demotion diagnostics. Captures every upstream signal we
    // checked so a TD can answer "which input was missing?" without re-running
    // the detector with extra console.logs. Surfaced via detection.debug.cupModel.
    const diagnostics = {
      hasFrontInner: !!hasFrontInner,
      apexLeftPresent: !!apexLeft,
      apexRightPresent: !!apexRight,
      apexLeftConf: Number.isFinite(lConf) ? lConf : 0,
      apexRightConf: Number.isFinite(rConf) ? rConf : 0,
      sidePicked: side,
      apexPointPresent: !!apexPoint,
      apexConfPicked: Number.isFinite(apexConf) ? apexConf : 0,
      cradleCupTopPresent: !!cradleCupTop,
      cradleCupSide,
      cradleCupSideMatches: !!(cradleCupTop && cradleCupSide === side),
      cradleYPresent: cradleY != null,
      cradleCupConfidence: Number.isFinite(cradleCupConfidence) ? cradleCupConfidence : 0,
      apexY,
      seamY,
      topFromApex,
      bottomFromSeam,
      bottomFromInk,
      bottomInkSupport: Number.isFinite(bottomInkSupport) ? bottomInkSupport : 0,
      visibility,
      visibilityReason,
    };
    if (visibility === 'hidden' && typeof console !== 'undefined' && console.warn) {
      console.warn('[Auto Mode] cupModel hidden → POM 9/10 will demote to REVIEW_ONLY', diagnostics);
    }

    // For 'direct' with only one of (apexY, seamY) present, extrapolate the
    // missing endpoint by a typical cup-height fraction of the normalized
    // image height (apexY / seamY are already 0–1 normalized). 0.28 is a
    // reasonable approximation across the demo sketches.
    if (visibility === 'direct') {
      const fallbackCupHeight = 0.28;
      if (apexY == null && seamY != null) apexY = clamp01(seamY - fallbackCupHeight);
      if (seamY == null && apexY != null) seamY = clamp01(apexY + fallbackCupHeight);
    }

    // -------- 5. Reject decorative/texture-only evidence -------------------
    // Per rule.md "Reject lace/flower/texture as primary cup evidence". We
    // don't run a dedicated texture detector here; instead we delegate to the
    // two upstream detectors whose validation already excludes decorative
    // candidates:
    //   - apex: validateCupApexPair rejects strap-join candidates that aren't
    //     symmetric and bounded inside the cup region
    //   - cradleCupTop: the POM 7 column scan rejects short decorative ticks,
    //     side-seam-like vertical runs, and ratio-only candidates
    // So a cupModel sourced from (apex, cradleCupTop) is texture-free by
    // construction. The only remaining failure mode is "neither signal fires";
    // that maps to visibility='hidden' above. texturePenalty stays 0 unless a
    // dedicated detector is added later.
    const texturePenalty = 0;
    const contourConfidence = clamp01(topFromApex ? apexConf : (apexConf * 0.4));
    // Bottom-endpoint provenance & confidence. A committed POM 7 seam is best;
    // a traced underwire arc (bottomFromInk) earns confidence from its column
    // support (0.30..1.0 support -> ~0.5..0.85) instead of the flat 0.25 guess
    // used when only the global cradle row is available.
    const bottomEvidence = bottomFromSeam ? 'seam'
      : (bottomFromInk ? 'ink'
        : (seamY != null ? 'cradleRow' : 'none'));
    const seamConfidence = bottomFromSeam
      ? clamp01(cradleCupConfidence || 0)
      : (bottomFromInk
        ? clamp01(0.35 + 0.5 * bottomInkSupport)
        : (seamY != null ? 0.25 : 0));

    if (visibility === 'hidden') {
      return {
        side, viewRole, visibility,
        topPoint: null, bottomPoint: null,
        innerEdge: null, outerEdgeNearArmhole: null, centerPoint: null,
        contourConfidence, seamConfidence, texturePenalty,
        sideReason, visibilityReason,
        topFromApex: false, bottomFromSeam: false, bottomFromInk: false, bottomEvidence: 'none',
        apexAnchor: null, seamAnchor: null,
        rejectedTextureReason: null,
        diagnostics,
        reason: `cup model hidden: ${visibilityReason}`,
      };
    }

    // -------- 6. Cup geometry — shared columns, coherent endpoints ---------
    // The cup occupies the band [sideColPx .. axisPx] for a left cup (and
    // [axisPx .. sideColPx] for right). The HEIGHT measurement runs through
    // the cup's vertical median (cupCenterX); the WIDTH measurement spans
    // the cup's full horizontal extent (innerEdge → outerEdge) at the cup's
    // vertical mid (centerY). sideColPx / cupCenterX are computed in step 1.

    // POM 10 endpoints — the reference draws cup width at the UPPER-MIDDLE of
    // the cup (from the center gore junction out to the outer cup edge), not at
    // the fullest row. We target that level and snap to the real cup ink there
    // when the dark mask is available, otherwise fall back to fixed insets from
    // the CF axis and side seam at the same level. Ink-based snapping picks the
    // inner (gore-side) and outer (side-seam-side) ink pixels on the picked cup
    // half so the width follows the drawn cup outline instead of a geometric
    // prior.
    //
    // Fallback rationale — see the historical note preserved below.
    //   A previous attempt swapped innerEdge to cradleCupTop.x assuming it
    //   marked the cup-gore boundary. It does not — cradleCupTop sits in the
    //   OUTER cup zone (where the cup-bottom seam rises toward chest near the
    //   side seam), so using it as the inner edge collapsed POM 10 width to
    //   near-zero. The inner edge is therefore always derived from the CF-axis
    //   side (ink edge, else a 3% axis inset), never a side-zone landmark.
    //
    // widthLevelY = apex + 0.42·(seam−apex): the fixed upper-middle level. It is
    // the fallback and also the upper floor of the widest-row search below (kept
    // above 0.40 so it stays within 0.08 of POM 9 mid-y, invariant A6).
    const widthLevelY = clamp01(apexY + 0.42 * (seamY - apexY));
    const pom9Mid = (apexY + seamY) / 2;

    // Deep cups: cup width is measured at the cup's WIDEST horizontal cross-
    // section, which on a deep cup sits BELOW the fixed 0.42 level. Search a
    // body-bounded, A6-clamped window for the widest coherent cup-ink row and
    // place the width line there. The window is ONE-SIDED — its floor is
    // widthLevelY, so it can only move the row DOWN — meaning shallow cups
    // (widest already at/above 0.42) keep today's placement and only cups with a
    // genuinely wider seam lower down descend. Capping hiY at pom9Mid+0.07
    // guarantees invariant A6 (|width_y−pom9Mid| < 0.08) by construction: 0.07 +
    // pixel rounding < 0.075 usability gate < 0.08. bodyHiY keeps the row off the
    // underwire/cradle band. Shallow cups skip the search entirely (byte-
    // identical output → no golden drift).
    const cupSpan = seamY - apexY;
    const DEEP_CUP_FRAC = 0.24;
    const bodyHiY = seamY - 0.15 * cupSpan;
    const widthWindow = {
      loY: widthLevelY,
      hiY: clamp01(Math.min(bodyHiY, pom9Mid + 0.07)),
    };
    // The legacy fixed-level probe is always computed — both as the fallback and
    // as the baseline width the widest-row search must clearly beat.
    const atLevel = findCupWidthFromInk(
      dark, w, h, bounds, axisPx, sideColPx, apexY, seamY, side, widthLevelY
    );
    let inkWidth = atLevel;
    if (cupSpan >= DEEP_CUP_FRAC && widthWindow.hiY > widthWindow.loY) {
      const windowed = findCupWidthFromInk(
        dark, w, h, bounds, axisPx, sideColPx, apexY, seamY, side, null, widthWindow
      );
      // Only descend to the lower row when the cup is MEANINGFULLY wider there
      // (a genuine deep bulge) — ≥12% wider than at the fixed level, and at least
      // 3% of cup span lower. This keeps roughly-uniform cups at today's level
      // (no spurious drift) and moves only the deep cups the fixed 0.42 level
      // strands too high.
      if (windowed
          && windowed.widthPx >= (atLevel ? atLevel.widthPx * 1.12 : 0)
          && windowed.centerY > widthLevelY + 0.03 * cupSpan) {
        inkWidth = windowed;
      }
    }
    // Guard against a stray-ink row that would violate invariant A6 (POM 10
    // row must lie within 0.08 of POM 9 mid-y). Also require the found row
    // to sit clearly BELOW the apex — otherwise it's likely strap-junction
    // ink, not a cup body row.
    const inkWidthUsable = !!(inkWidth
      && Math.abs(inkWidth.centerY - pom9Mid) < 0.075
      && inkWidth.centerY > apexY + 0.02);

    // Cup-width vertical reference — the widest ink row when accepted, else the
    // geometric upper-middle level.
    const centerY = inkWidthUsable
      ? clamp01(inkWidth.centerY)
      : widthLevelY;

    // POM 9 endpoints — cup height runs from the APEX (cup-strap join, the true
    // top of the cup) down to the cup-bottom at the cup's vertical median. A TD
    // reads cup height from the apex, so the top anchor sits on the detected
    // apex point rather than being projected onto the cup-center column (which
    // floated above the cup edge, since the cup top dips from the apex toward
    // the gore). The bottom stays on the cup-center column at the cup-bottom
    // seam. The line therefore tilts slightly apex→bottom (rendered as a curve)
    // — that matches the TD's cup-height convention. When no apex fired
    // (topFromApex false) there is no real top landmark, so fall back to the
    // cup-center column for a coherent vertical estimate.
    const topX = (topFromApex && apexPoint) ? apexPoint.x : cupCenterX;
    const topPoint    = { x: clamp01(topX), y: clamp01(apexY) };
    // Bottom sits under the cup BODY, not at the geometric side↔CF midpoint.
    // When the apex is at the outer-top (strap join near the side seam), the
    // plain cup-center leans toward CF and the bottom drifts off the cup; bias
    // it halfway from the apex column toward the cup center so POM 9 runs down
    // the cup body. Falls back to the cup center when no apex fired.
    const bottomXraw = (topFromApex && apexPoint) ? (apexPoint.x + cupCenterX) / 2 : cupCenterX;
    // bottomPoint is created AFTER the width endpoints below, so it can be
    // clamped to sit between them (invariant A5).

    // Inner endpoint = the CENTER-FRONT gore junction (where the two cups meet),
    // per the reference. That is a STRUCTURAL point at the CF, not the cup's ink
    // edge at this level — near the top the cup's inner edge curves inward under
    // the neckline V, which would shorten the width. So anchor the inner
    // endpoint just off the CF axis (a small gore inset, ≥ invariant B3's 0.5%),
    // guaranteeing it sits at the gore and that POM 9's column falls between the
    // two POM 10 endpoints (invariant A5).
    const axisPadPx = Math.max(2, Math.round(bboxW * 0.006));
    // Size the gore inset in IMAGE-width terms (0.8% of w) so the inner
    // endpoint always clears invariant B3 (>0.5% of image width off the CF
    // axis) regardless of how much of the frame the cup bbox fills — a bbox-
    // relative inset can shrink below the B3 floor on wide two-view sketches.
    const goreInsetPx = Math.max(axisPadPx, Math.ceil(w * 0.008));
    const goreInsetXpx = side < 0 ? axisPx - goreInsetPx : axisPx + goreInsetPx;
    // On a WIDE center gore the cups are separated by a broad (often faint mesh)
    // panel; the gore inset then floats the inner endpoint in the gore instead
    // of on the cup. Trace the cup's inner seam at the width row and pull the
    // endpoint OUTWARD onto it. Only ever moves away from the axis (never past
    // the gore inset toward center), so invariant B3 (>0.5% off CF axis) holds.
    const innerSilPx = findCupInnerSilhouettePx(
      dark, w, h, bounds, axisPx, cupCenterXpx, Math.round(centerY * h), side, goreInsetPx);
    let innerEdgeXpx = goreInsetXpx;
    if (innerSilPx != null) {
      innerEdgeXpx = side < 0
        ? Math.min(goreInsetXpx, innerSilPx)   // smaller x = further from axis (left cup)
        : Math.max(goreInsetXpx, innerSilPx);
    }
    const innerEdge = { x: clamp01(innerEdgeXpx / w), y: centerY };
    diagnostics.innerEdgeSilhouettePx = innerSilPx;
    diagnostics.innerEdgeExtendedToSeam = innerSilPx != null && innerEdgeXpx !== goreInsetXpx;
    // Ink support for the inner endpoint. The gore inset is a FABRICATED
    // fallback — legitimate only when the point lies inside the garment. On
    // front-closure styles whose apex fires on the strap top, the width row
    // crosses the OPEN neckline V and the inset point floats in blank
    // background. Consumers (landmark-qa cupModelUsable, seed
    // innerCupFromCupModel) treat innerEdgeSupported === false as "cup model
    // not usable for anchors" so the seed falls down the existing precedence
    // chain (innerCupTopInk → view ratios → delete) instead.
    // "Inside the garment" test: faint fills (lace texture) don't register in
    // the dark mask, so ink-proximity alone can't tell garment interior from
    // the neckline opening. But every garment-interior point has the
    // neckline/top edge line somewhere ABOVE it, while a point in the open
    // neckline V sees nothing but background all the way to the ink-bbox top.
    let innerEdgeSupported = innerSilPx != null;
    if (!innerEdgeSupported && dark) {
      const rowPx = Math.min(h - 1, Math.max(0, Math.round(centerY * h)));
      const cLo = Math.max(minX, innerEdgeXpx - 2);
      const cHi = Math.min(maxX, innerEdgeXpx + 2);
      scan: for (let y = rowPx - 1; y >= Math.max(0, bounds.minY); y -= 1) {
        const rowBase = y * w;
        for (let x = cLo; x <= cHi; x += 1) {
          if (dark[rowBase + x]) { innerEdgeSupported = true; break scan; }
        }
      }
    }
    diagnostics.innerEdgeSupported = innerEdgeSupported;
    if (!innerEdgeSupported && typeof console !== 'undefined' && console.warn) {
      console.warn('[Auto Mode] cupModel inner edge unsupported (width row crosses a void) → cup model not usable for POM 9/10 anchors');
    }

    // Outer endpoint = the cup's OUTER edge near the armhole. Prefer the traced
    // outer ink edge when it is a valid outer boundary (on the side-seam side of
    // the cup center); otherwise a small inset from the detected side-seam
    // column. Invariant B4 keeps it ≥0.3% off the side seam.
    const outerInsetPx = Math.max(2, Math.round(bboxW * 0.02));
    const outerFallbackXpx = side < 0 ? sideColPx + outerInsetPx : sideColPx - outerInsetPx;
    // Size the seam pad in IMAGE-width terms as well (0.4% of w): invariant B4
    // measures the seam gap as a fraction of the full image (>0.3%), and a
    // purely bbox-relative pad bottoms out at 2px on multi-view sketches whose
    // ink bbox is a small fraction of the frame — landing the outer endpoint
    // inside the B4 floor (same failure class as the B3 gore inset above).
    const seamPadPx = Math.max(2, Math.round(bboxW * 0.004), Math.ceil(w * 0.004));
    const outerInkValid = inkWidthUsable
      && (side < 0 ? inkWidth.outerX < cupCenterX : inkWidth.outerX > cupCenterX);
    // POM 10 must span the full cup — CF gore → outer side seam. The traced ink
    // edge may pull the outer endpoint FURTHER OUT toward the seam, but must
    // never narrow the cup inward: sketches with interior panel/princess seams
    // were snapping the ink to an inner seam, ending POM 10 ~30% short of the
    // cup. Reach the detected side seam (outerFallbackXpx) and let ink only
    // extend it outward, floored a hair inside the seam (invariant B4).
    const inkOuterXpx = outerInkValid ? Math.round(inkWidth.outerX * w) : outerFallbackXpx;
    const outerEdgeSeamXpx = side < 0
      ? Math.max(sideColPx + seamPadPx, Math.min(outerFallbackXpx, inkOuterXpx))
      : Math.min(sideColPx - seamPadPx, Math.max(outerFallbackXpx, inkOuterXpx));
    // The side-seam column can land INBOARD of the cup's true outer outline
    // (interior/princess seams, faint side seams). Trace the outer silhouette at
    // the width row and let it extend the endpoint OUTWARD to the real cup edge
    // (floored a hair inside the outline, invariant B4). Never narrows the cup.
    const silhouettePx = findCupOuterSilhouettePx(dark, w, h, bounds, axisPx, Math.round(centerY * h), side);
    let outerEdgeXpx = outerEdgeSeamXpx;
    if (silhouettePx != null) {
      const silPadded = side < 0 ? silhouettePx + seamPadPx : silhouettePx - seamPadPx;
      outerEdgeXpx = side < 0
        ? Math.min(outerEdgeSeamXpx, silPadded)   // smaller x = further outboard
        : Math.max(outerEdgeSeamXpx, silPadded);
    }
    const outerEdgeNearArmhole = { x: clamp01(outerEdgeXpx / w), y: centerY };
    diagnostics.outerEdgeSilhouettePx = silhouettePx;
    diagnostics.outerEdgeExtendedToSilhouette = silhouettePx != null && outerEdgeXpx !== outerEdgeSeamXpx;
    // POM 9 bottom (deferred from above): clamp the apex-biased column to sit
    // between the POM 10 width endpoints so the height line stays on the cup
    // body (invariant A5) — on a degenerate narrow cup the raw column can fall
    // just outside the span.
    const bottomLoX = Math.min(innerEdge.x, outerEdgeNearArmhole.x);
    const bottomHiX = Math.max(innerEdge.x, outerEdgeNearArmhole.x);
    const bottomPoint = { x: clamp01(Math.max(bottomLoX, Math.min(bottomHiX, bottomXraw))), y: clamp01(seamY) };
    diagnostics.innerEdgeSource = 'goreAnchor';
    diagnostics.outerEdgeSource = outerInkValid ? 'ink' : 'sideInset';
    diagnostics.innerEdgeX = innerEdge.x;
    diagnostics.outerEdgeX = outerEdgeNearArmhole.x;
    if (inkWidth) {
      diagnostics.cupWidthInkRow = inkWidth.centerY;
      diagnostics.cupWidthInkFrac = inkWidth.widthFrac;
      diagnostics.cupWidthInkUsable = inkWidthUsable;
    }

    // Cup geometric center (debug only — POM 10 spans inner→outer, NOT
    // center→outer).
    const centerPoint = { x: clamp01(cupCenterX), y: centerY };

    // Raw landmark sources kept for debug/inspection.
    const apexAnchor = apexPoint
      ? { x: apexPoint.x, y: apexPoint.y }
      : null;
    const seamAnchor = (seamRawX != null && seamY != null)
      ? { x: seamRawX, y: seamY }
      : null;

    return {
      side, viewRole, visibility,
      topPoint, bottomPoint, innerEdge, outerEdgeNearArmhole, centerPoint,
      innerEdgeSupported,
      contourConfidence, seamConfidence, texturePenalty,
      sideReason, visibilityReason,
      topFromApex, bottomFromSeam, bottomFromInk, bottomEvidence,
      apexAnchor, seamAnchor,
      rejectedTextureReason: null,
      diagnostics,
      reason: visibility === 'direct'
        ? (hasFrontInner
          ? `direct cup view (front_inner): ${sideReason}`
          : `direct front cup (apex + ${bottomFromSeam ? 'cup-bottom seam' : 'traced underwire arc'}): ${sideReason}`)
        : `inferred cup model from ${topFromApex ? 'apex' : 'no apex'} + ${bottomFromSeam ? 'cup-bottom seam' : (bottomFromInk ? 'traced underwire arc' : 'cradle row reference')}: ${sideReason}`,
    };
  }
