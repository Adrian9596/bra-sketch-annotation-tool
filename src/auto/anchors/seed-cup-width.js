// POM 9 / POM 10 cup geometry for the anchor seed pass: the shared-cupModel
// endpoints, the contour-traced cup inner seam, and the ADR 0036 cup-width
// extremes (each endpoint carrying its own height) plus the two appliers that
// layer them onto a seed set.
// Source part for app.js. Run `npm run build` after editing.
//
// Everything here needs only `detection`, a `cupModel`, and the frontView box
// resolved in seed-view-resolution.js — none of the front/back branch
// bookkeeping. seed-front-view.js is the caller; the CF cradle geometry for
// POM 6/8 lives in seed-cradle-cf.js.

    // POM 9/10 inner-cup endpoints from the shared cupModel, in source-image
    // [0,1] space. Returns null when the model isn't usable (hidden or missing
    // an endpoint) so callers fall back to their own heuristics. inner-cup-left
    // always gets the smaller x so canvas geometry stays "left → right"
    // regardless of which cup side the model picked. Single source of truth for
    // both the frontView and frontInnerView branches below.
  function innerCupFromCupModel(cm) {
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
  }

    // Contour-based cup INNER seam (POM 10 width). buildCupModel runs BEFORE the
    // vector trace, so its innerEdge is a pixel guess that a solid center-gore
    // detail (CF seam, bow) can pull toward the CF axis — leaving the endpoint
    // floating in the gore instead of on the cup. detection.contours is traced
    // by the time we seed, so use the cup panel's outline: its edge nearest the
    // axis is the true inner seam. Returns the seam x (normalized) or null.
  function cupInnerSeamFromContours(cm, detection, frontView) {
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
      // Collect EVERY cup-side panel contour that spans the width row. Picking
      // only the LARGEST one (the original behaviour) breaks a molded/seamed cup:
      // such a cup is traced as SEVERAL panels split by a style seam, and the
      // biggest panel is often an INTERIOR one whose gore-side crossing at rowY
      // stops well short of the true cup↔gore seam. Because the search never left
      // that panel, the inner endpoint was pulled INTO the cup and POM 10 came out
      // ~40% narrow (EvelynBliss vA 2.0 front-inner cup: seam 0.1256 vs the real
      // gore edge 0.1650 — cup width 24% of its view panel instead of ~40%). The
      // inner seam is the crossing nearest the CF axis across ALL cup panels, so
      // scan them all and let the gates below reject anything off-cup.
      const candidatePaths = [];
      for (const p of C.paths) {
        const b = p && p.bbox; if (!b) continue;
        const bMinX = b.x, bMaxX = b.x + b.width, bMinY = b.y, bMaxY = b.y + b.height;
        const cx = (bMinX + bMaxX) / 2;
        if (side < 0 ? cx >= axisX : cx <= axisX) continue;        // cup side only
        if (b.width > viewW * 0.6) continue;                       // not the whole outline
        if (b.height < viewH * 0.20) continue;                     // a real cup panel
        if (rowY < bMinY - 0.02 || rowY > bMaxY + 0.02) continue;  // spans the width row
        candidatePaths.push(p);
      }
      if (!candidatePaths.length) return null;
      // Sample each panel outline and take where it ACTUALLY crosses y = rowY.
      // The bbox horizontal extreme (bMaxX/bMinX) sits at the panel's widest
      // row — the apex, not rowY — so using it floated the endpoint ~17px
      // off-ink and inflated cup width (~+7.5% on demo5). The inner seam is the
      // crossing nearest the CF axis, on the cup side, off-axis. A crossing at
      // rowY is by construction on the traced ink, so this doubles as the
      // "must lie on ink at rowY" gate: no valid crossing → null → fall back.
      let innerX = null;
      for (const path of candidatePaths) {
        const samples = samplePathPoints(path);
        const n = samples.length;
        if (n < 2) continue;
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
      }
      return innerX == null ? null : clamp01(innerX);
  }

    // POM 10 cup width, TD convention (2026-07-25): the line spans the cup's TRUE
    // horizontal extremes — the gore contact on the inner side, the wire/side-seam
    // end on the outer side — and each endpoint keeps ITS OWN height, so the width
    // follows the cup's structure instead of being flattened onto one shared row
    // (the gore contact sits lower than the side-seam end on every style a TD
    // measures). Taking x AND y from the SAME traced contour point is what puts
    // the endpoint on ink: the historical A1 defect was pairing a bbox-extreme x
    // with a forced centerY, which planted the anchor at a height the cup never
    // reaches. Returns { inner, outer } in source-image [0,1] space, or null so
    // callers fall back to the row-crossing snap below.
  function cupWidthExtremesFromContours(cm, detection, frontView) {
      const C = detection.contours;
      if (!C || !Array.isArray(C.paths) || !cm || cm.side == null) return null;
      const side = cm.side;
      const axisX = detection.axisX;
      if (axisX == null) return null;
      let rowY = cm.innerEdge ? cm.innerEdge.y : (cm.centerPoint ? cm.centerPoint.y : null);
      if (rowY == null) return null;
      // Front-inner cutaway: cupModel.topPoint runs up into the STRAP, not the cup.
      // buildCupModel derives the width level as apex + 0.42·(seam − apex), so that
      // inflated span drags the row far above the cup's widest part. Measured on the
      // 2-photo case (Evelyn vA 3.0): topPoint.y 0.1140 (strap top) vs the clamped
      // inner-cup-top 0.3319 gave row 0.1140 + 0.42·(0.8153 − 0.1140) = 0.4085 —
      // 0.165 above POM 9's mid-y 0.5736, i.e. more than DOUBLE the A6 limit, while
      // anchors 171/181 sat at ~0.59 showing where the cup is actually widest.
      // IC-top is already clamped DOWN to strapBottom for this view; apply the SAME
      // clamped top here so the row and POM 9 agree (recomputes to 0.5349, A6 delta
      // 0.0387). Front-outer views never take this branch.
      if (detection.singleView && cm.topPoint && cm.bottomPoint
          && detection.strapBottom && typeof detection.strapBottom.y === 'number'
          && detection.strapBottom.y > cm.topPoint.y
          && cm.bottomPoint.y > detection.strapBottom.y) {
        const topUsed = detection.strapBottom.y;
        rowY = clamp01(topUsed + 0.42 * (cm.bottomPoint.y - topUsed));
      }
      const fv = frontView;
      const viewW = fv ? fv.width : 1;
      const viewH = fv ? fv.height : 1;
      // Same panel gates as the row-crossing search, and every qualifying panel
      // is scanned (a molded cup is traced as several style-seam panels).
      // Horizontal bounds of the view this cup belongs to. REQUIRED: the old
      // row-crossing search clamped x into a narrow window (cup centre → just
      // inside the axis), so it could never leave the view. An extreme has no such
      // window, and on a multi-view board a BACK-panel contour also satisfies
      // "centre is on the cup side of axisX" — so the outer extreme escaped into
      // the next panel and moved inner-cup-right by 0.279 on 1.jpg (a right cup,
      // where outer = max x, i.e. straight toward the neighbouring views).
      const viewLoX = fv ? fv.x : 0;
      const viewHiX = fv ? fv.x + fv.width : 1;
      const paths = [];
      for (const p of C.paths) {
        const b = p && p.bbox; if (!b) continue;
        const cx = b.x + b.width / 2;
        if (cx < viewLoX || cx > viewHiX) continue;                // this view only
        if (b.height < viewH * 0.20) continue;                     // a real panel
        if (rowY < b.y - 0.02 || rowY > b.y + b.height + 0.02) continue;
        // The view-wide garment outline is NOT usable here. It was tried (letting it
        // feed the outer endpoint only) to reach the cup's outer edge, and on a
        // front-inner cutaway it does — but on a normal front-outer sketch the
        // silhouette at cup height runs along the SIDE WING / band, well outside the
        // cup, so the endpoint landed on the wing (panel-relative 0.011 where the TD
        // marked 0.039) and POM 10 moved up to 0.097 on demo7. It only looked correct
        // because the outer overshoot cancelled an inner shortfall of the same size.
        // The cup's outer edge belongs to cupModel.outerEdgeNearArmhole, which is
        // already band-aware (findCupOuterSilhouettePx + the side-seam ratchet).
        if (b.width > viewW * 0.6) continue;                       // not the whole outline
        if (side < 0 ? cx >= axisX : cx <= axisX) continue;        // cup side only
        paths.push(p);
      }
      if (!paths.length) return null;
      // Keep clear of the CF gore and the side seam so invariants B3/B4 hold. Both
      // pads sit just above their invariant floors (B3 needs > 0.005 from the axis,
      // B4 > 0.003 from the side column): POM 10 must reach the cup's widest extent,
      // so every extra thousandth of pad is width the TD asked for and did not get.
      const axisPad = 0.006;
      const seamPad = 0.004;
      const sideCol = side < 0 ? detection.sideLeftX : detection.sideRightX;
      // Restrict candidates to a band around the width row. Global cup extremes
      // run all the way down to the wire, which slants the line far more than a
      // TD draws it (|Δy| reached 0.177 on demo3 — the endpoint had slid to the
      // gore's bottom). A band keeps this the WIDEST CHORD THROUGH THE CUP'S
      // MID-SECTION: each endpoint still finds its own natural height, but both
      // stay near mid-height, which is what the measurement means (and what
      // keeps the A6 row check meaningful).
      // Capped in absolute terms too: the endpoints must still read as ONE width
      // measurement near mid-height (invariant A6 bounds the row against POM 9's
      // mid-y), so an endpoint may find its own height but not wander a fifth of
      // the sketch away from the row.
      // A teardrop cup is widest BELOW mid-height, so a tight band centred on the
      // width row can miss the widest row entirely and shorten BOTH ends at once
      // (measured: outer stuck at the contour limit 0.072 while the TD marked 0.039,
      // inner 0.461 vs 0.494). Widened so the gore contact and the true widest row
      // fall inside it. The slant stays governed by invariant A3 (< 0.09) and the
      // pair's mean is still anchored to the row, so A6 is unaffected.
      const cupSpan = (cm.topPoint && cm.bottomPoint) ? (cm.bottomPoint.y - cm.topPoint.y) : null;
      const bandHalf = cupSpan != null
        ? Math.min(Math.max(0.02, cupSpan * 0.20), 0.07)
        : 0.06;
      const bandLoY = rowY - bandHalf;
      const bandHiY = rowY + bandHalf;
      let inner = null, outer = null;
      const scan = (path) => {
        for (const pt of samplePathPoints(path)) {
          if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
          if (pt.x < viewLoX || pt.x > viewHiX) continue;           // never leave the view
          if (pt.y < bandLoY || pt.y > bandHiY) continue;          // mid-section band
          // Stay on the cup body: above the apex is strap, below the seam is band.
          if (cm.topPoint && pt.y < cm.topPoint.y - 0.01) continue;
          if (cm.bottomPoint && pt.y > cm.bottomPoint.y + 0.01) continue;
          if (!(side < 0 ? pt.x < axisX - axisPad : pt.x > axisX + axisPad)) continue;
          // outer = farthest from the CF axis; inner = nearest it.
          if (!outer || (side < 0 ? pt.x < outer.x : pt.x > outer.x)) outer = { x: pt.x, y: pt.y };
          if (!inner || (side < 0 ? pt.x > inner.x : pt.x < inner.x)) inner = { x: pt.x, y: pt.y };
        }
      };
      for (const path of paths) scan(path);
      if (!inner || !outer) return null;
      // The traced cup panels stop SHORT of the cup's real outer edge: on this sketch
      // the panel contour bottoms out at panel-relative 0.075 while the TD marked
      // 0.039, and widening the band barely moved it (0.072 -> 0.068) — proof it is a
      // contour limit, not a band limit. The cup's outer edge coincides with the
      // garment silhouette, which is unusable here (it tracks the side wing; see the
      // rejected experiment in ADR 0036). cupModel.outerEdgeNearArmhole already solves
      // exactly this, band-aware, via findCupOuterSilhouettePx + the side-seam
      // ratchet — so take its x and keep the contour-derived y so the anchor stays on
      // ink. Applied only when it sits FARTHER out: this can widen POM 10, never
      // narrow it.
      if (cm.outerEdgeNearArmhole && Number.isFinite(cm.outerEdgeNearArmhole.x)) {
        const modelX = cm.outerEdgeNearArmhole.x;
        if (side < 0 ? modelX < outer.x : modelX > outer.x) outer = { x: modelX, y: outer.y };
      }
      // Centre the PAIR exactly on the detected width row. Each endpoint finds its
      // own height (that is the whole point — the gore contact sits lower than the
      // side-seam end), but the MEAN of the two stays at the row, so the level the
      // measurement represents is unchanged from the single-row era. Without this,
      // both endpoints could drift the same way and slide the measurement off that
      // level (invariant A6 hit 0.099 on demo4). Anchoring the mean makes A6 read
      // exactly as it did before this change on every style, while the slant (Δy)
      // is preserved untouched.
      const meanShift = rowY - ((inner.y + outer.y) / 2);
      inner = { x: inner.x, y: inner.y + meanShift };
      outer = { x: outer.x, y: outer.y + meanShift };
      if (sideCol != null && Math.abs(outer.x - sideCol) < seamPad) {
        // Invariant B4 wants a GAP from the side-seam column, not a specific side
        // of it — so resolve a too-close endpoint by pushing it OUTWARD (away from
        // the cup centre), never inward. Flooring it at `sideCol + pad` (the first
        // cut here) narrowed the cup badly whenever the detected side column sits
        // INBOARD of the cup's real outline, which is the norm on a front-inner
        // cutaway that has no band ink: it cost ~8.7% of the panel on the outer
        // end. POM 10 must reach the cup's widest extent (TD convention, ADR 0036).
        outer = { x: side < 0 ? sideCol - seamPad : sideCol + seamPad, y: outer.y };
      }
      if (Math.abs(inner.x - outer.x) < 0.01) return null;         // degenerate span
      return {
        inner: { x: clamp01(inner.x), y: clamp01(inner.y) },
        outer: { x: clamp01(outer.x), y: clamp01(outer.y) },
      };
  }

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
  function applyContourInnerSeam(pts, cm, detection, frontView) {
      if (!pts || !cm) return pts;
      const seamX = cupInnerSeamFromContours(cm, detection, frontView);
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
  }

    // Preferred POM 10 placement: both endpoints from the traced cup extremes,
    // each carrying its own y (see cupWidthExtremesFromContours). Falls back to
    // the single-row inner-seam snap when the trace can't supply a clean span, so
    // styles without usable contours keep their previous behaviour. POM 9's bottom
    // column is re-clamped into the span either way (invariant A5).
  function applyContourCupWidth(pts, cm, detection, frontView) {
      if (!pts || !cm) return pts;
      const ext = cupWidthExtremesFromContours(cm, detection, frontView);
      // Record WHICH placement ran. This fallback used to be silent, which is how a
      // 2-image board (primary + separate front-inner cutaway) kept the old
      // shared-row POM 10 while every single-image suite passed: the aux photo had
      // no detection.contours, the extremes declined, and nothing said so. Tests
      // assert this field so the degraded path can never pass unnoticed again.
      detection.cupWidthSource = ext
        ? 'contour-extremes'
        : (detection.contours ? 'inner-seam-fallback' : 'no-contours');
      if (!ext) {
        // Say it out loud. A usable cup model that still cannot place POM 10 from
        // the trace means the inputs are degraded (most often: contours were never
        // traced for this photo), and the anchors silently revert to the superseded
        // shared-row placement. That silence is exactly how the 2-image board
        // regression survived a full green suite run.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[Auto Mode] POM 10 fell back to the shared-row inner-seam snap'
            + ' (cupWidthSource=' + detection.cupWidthSource + ') — ADR 0036 placement unavailable'
            + (detection.sourceImageId != null ? ' for image ' + detection.sourceImageId : '') + '.');
        }
        return applyContourInnerSeam(pts, cm, detection, frontView);
      }
      const a = ext.inner, b = ext.outer;
      const left  = a.x <= b.x ? a : b;
      const right = a.x <= b.x ? b : a;
      const lo = Math.min(left.x, right.x), hi = Math.max(left.x, right.x);
      const bottom = {
        x: clamp01(Math.max(lo, Math.min(hi, pts.bottom.x))),
        y: pts.bottom.y,
      };
      return { top: pts.top, bottom, left, right };
  }
