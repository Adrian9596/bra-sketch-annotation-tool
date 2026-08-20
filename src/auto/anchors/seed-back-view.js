// Back-view anchor seeding: POM 11 (back side seam), POM 12 (back center
// length), POM 13 (back panel height), the back end of POM 14 (strap-bottom),
// and POM 15 (back strap distance), all from the back-* ink detectors.
// Source part for app.js. Run `npm run build` after editing.
//
// Self-contained: it needs only the backView box resolved in
// seed-view-resolution.js plus detection's back-* fields — no cup-width or
// front-branch state. The front counterpart lives in seed-front-view.js.

  function seedBackViewAnchors(detection, seeds, seedCtx) {
    const { backView, roleByKind, backPanelInk, backPanelHeightInk } = seedCtx;
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
      // Same one-row rule as the front band/chest pairs above: POM 15 is a
      // horizontal span, and it draws level at the LEFT end's y, so the two
      // ends must sit on ONE row or the line misses the right anchor. Resolve
      // the row ONCE — mean of the two ink edges when both are detected (they
      // agree on every fixture, so this is a no-op there), the single detected
      // edge when only one is, then the back chest row, then one shared ratio
      // instead of the old mismatched 0.414 / 0.426 pair.
      const bStrapInkL = bStrapInner && bStrapInner.left ? bStrapInner.left : null;
      const bStrapInkR = bStrapInner && bStrapInner.right ? bStrapInner.right : null;
      const bStrapY = (bStrapInkL && bStrapInkR)
        ? (bStrapInkL.y + bStrapInkR.y) / 2
        : (bStrapInkL ? bStrapInkL.y
          : (bStrapInkR ? bStrapInkR.y
            : (bf && (bf.chestLeftX != null || bf.chestRightX != null)
              ? bChestY
              : b.y + b.height * 0.414)));
      const bStrapL = {
        x: bStrapInkL ? bStrapInkL.x
          : (bf && bf.chestLeftX  != null ? bf.chestLeftX  : inViewX(b, 0.276)),
        y: bStrapY,
      };
      const bStrapR = {
        x: bStrapInkR ? bStrapInkR.x
          : (bf && bf.chestRightX != null ? bf.chestRightX : inViewX(b, 0.729)),
        y: bStrapY,
      };
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
    return seeds;
  }
