// Front-view anchor seeding: the front-outer branch (chest / band / CF /
// inner-cup / apex POM 16 / strap-top POM 14 / neckline POM 17 / armhole
// POM 18) and the front-inner remap branch that transfers those anchors onto
// a 3-view board's front-inner panel (ADR 0034).
// Source part for app.js. Run `npm run build` after editing.
//
// Both branches run over the context resolved in seed-view-resolution.js and
// the POM 9/10 cup geometry in seed-cup-width.js; the back-view counterpart
// lives in seed-back-view.js. The front-inner branch is a coordinate remap of
// the front-outer branch's output, so the two stay in one file.

  function seedFrontViewAnchors(detection, seeds, seedCtx) {
    const {
      frontView, backView, roleByKind,
      left, halfW, ax, band, cfBottomY, chest, cradle, sideL, sideR, icSide,
      cupModel, innerCupTopInk, sideTopRightInk,
    } = seedCtx;
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
      // band-left/-right are the two ends of ONE horizontal band row, and
      // chest-left/-right of ONE chest row — so both ends must share that
      // row's y and only the x may fall back per side. Taking a per-side
      // view-box y (the old `inView(f, rx, ry)` fallback) put the two ends at
      // DIFFERENT heights whenever the walker found ink on just one side, and
      // for chest even when it found neither: the two ratios disagreed with
      // each other (0.615 vs 0.605) and with chestSeedY's own 0.615 fallback.
      // POM 1/3 force their line level at the LEFT end's y and POM 2/4 hang
      // off the RIGHT end's y, so any such gap showed up as lines 1-4 sitting
      // vertically off anchors that were themselves correctly placed.
      // The ink-on-both-sides path is unchanged, which is what every golden
      // fixture exercises.
      const useChestL = { x: chestSeedLeftX  != null ? chestSeedLeftX  : inViewX(f, 0.004), y: chestSeedY };
      const useChestR = { x: chestSeedRightX != null ? chestSeedRightX : inViewX(f, 0.990), y: chestSeedY };
      const useBandL  = { x: detection.bandLeftX  != null ? detection.bandLeftX  : inViewX(f, 0.063), y: bandYf };
      const useBandR  = { x: detection.bandRightX != null ? detection.bandRightX : inViewX(f, 0.936), y: bandYf };
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
      const frontCupPts = applyContourCupWidth(innerCupFromCupModel(cupModel), cupModel, detection, frontView);
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
      // Front-inner cutaway (singleView): the cup-model top runs up into the
      // strap, so inner-cup-top seeds at the apex. The TD measures cup height
      // from the strap→cup seam, so drop IC-top DOWN to that seam (never up),
      // keeping its x. Front-outer views are unaffected (TD 2026-07-22).
      if (detection.singleView && useIcTop
          && detection.strapBottom && typeof detection.strapBottom.y === 'number'
          && detection.strapBottom.y > useIcTop.y) {
        useIcTop = { x: useIcTop.x, y: clamp01(detection.strapBottom.y) };
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
      // On a front-outer line sketch the join sits ~1/3 of the way from apex
      // toward strapBottom (0.35). On a front-INNER molded cutaway (singleView)
      // the apex sits much higher relative to the seam, so 0.35 leaves 172/182
      // up at the apex; the TD wants them at the strap→cup seam itself, so bias
      // almost all the way to strapBottom (TD 2026-07-22, Evelyn 2-photo case).
      const STRAP_JOIN_FRAC = detection.singleView ? 0.9 : 0.35;
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
      // Hem-following bottom at the CF column (US-061); cfBottomY falls back to
      // the flat band row when detection resolved no hem there.
      const useCfBottom = (detection.bandY != null && detection.axisX != null)
        ? { x: clamp01(detection.axisX), y: clamp01(cfBottomY) }
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
    return seeds;
  }

  function seedFrontInnerViewAnchors(detection, seeds, seedCtx) {
    const { frontView, frontInnerView, roleByKind } = seedCtx;
    if (frontInnerView && frontInnerView.width > 0 && frontInnerView.height > 0
        && frontView && frontView.width > 0 && frontView.height > 0
        && frontInnerView !== frontView) {
      const i = frontInnerView;
      const fv = frontView;
      const innerChestY = i.y + i.height * 0.22;
      // A single photo that already contains a front-inner panel (a 3-view
      // board: front-outer + back + front-inner) needs no second photo. The
      // inner panel shows the SAME garment as the front-outer panel, so every
      // cup / neckline / armhole POM measured on the front maps to the
      // corresponding RELATIVE position on the inner panel. Transfer the
      // front-outer-derived anchors (already seeded above, in front-box space —
      // themselves cup-model / ink derived, so this carries the real detected
      // shape, not view-box ratios) onto the inner box, then tag them to the
      // front-inner view. ADR-0034: POM 9/10 (inner cup) AND 17/18
      // (neckline/armhole) measure on the inner view; POM 8 stays on the
      // front-outer view (center-front, anchors shared with POM 5/6) so it is
      // deliberately NOT in this list. The separate-photo (aux-view) path is
      // handled independently in runOfflineDetection and never reaches here.
      const remap = (pt) => (pt ? {
        x: clamp01(i.x + (pt.x - fv.x) / fv.width * i.width),
        y: clamp01(i.y + (pt.y - fv.y) / fv.height * i.height),
      } : pt);
      const INNER_VIEW_KINDS = [
        'inner-cup-top', 'inner-cup-bottom', 'inner-cup-left', 'inner-cup-right',
        '171', '172', '181', '182',
      ];
      for (const kind of INNER_VIEW_KINDS) {
        if (seeds[kind]) seeds[kind] = remap(seeds[kind]);
        roleByKind[kind] = 'front_inner';
      }
      if (!detection.innerCupTop) {
        detection.innerCupTop = { x: i.x + i.width * 0.50, y: innerChestY };
      }
      if (detection.cradleY == null) detection.cradleY = i.y + i.height * 0.92;
      if (detection.underbustY == null) detection.underbustY = i.y + i.height * 0.54;
    }
    return seeds;
  }
