  // ===========================================================================
  // Curve geometry. All cubic Bézier math and curved-line construction live
  // here so future curve tweaks are in one place. The build concatenates every
  // src/*.js part into one shared scope, so these are callable from
  // manual-tools.js / rendering.js without any import wiring.
  //
  //   Data model: a curved annotation is one or two cubic Bézier segments.
  //   With a middle anchor (midPoint) + its two handles (midHandleIn/Out) it's
  //   two segments joined there; otherwise a single cubic via control1/control2.
  // ===========================================================================

  // A curved line is one or more cubic Bézier segments. The floor is the
  // pen-tool single cubic (start/control1/control2/end); a TD may grow it with
  // any number of interior anchor points (US-093 / ADR 0053), each an
  // independent {point, handleIn, handleOut}, added on demand via the "Add
  // point" tool — never a structural default. Everything that samples, draws,
  // or measures a curve goes through here, so an empty/absent `points` array
  // renders byte-identical to the original two-handle model.
  //
  // The legacy midPoint/midHandleIn/midHandleOut two-segment shape (rejected
  // 2026-07-18, "rối tay cầm, khó bẻ") is unrelated to `points` and is still
  // collapsed away by ensureCurveControls before this ever sees it.
  function getCurveBeziers(ann) {
    if (!ann || ann.type !== 'curved') return [];
    if (ann.midPoint && ann.midHandleIn && ann.midHandleOut) {
      return [
        { p0: ann.start, p1: ann.control1, p2: ann.midHandleIn, p3: ann.midPoint },
        { p0: ann.midPoint, p1: ann.midHandleOut, p2: ann.control2, p3: ann.end },
      ];
    }
    const points = Array.isArray(ann.points) ? ann.points : null;
    if (!points || !points.length) {
      return [{ p0: ann.start, p1: ann.control1, p2: ann.control2, p3: ann.end }];
    }
    const segs = [];
    let p0 = ann.start, p1 = ann.control1;
    for (const pt of points) {
      segs.push({ p0, p1, p2: pt.handleIn, p3: pt.point });
      p0 = pt.point;
      p1 = pt.handleOut;
    }
    segs.push({ p0, p1, p2: ann.control2, p3: ann.end });
    return segs;
  }

  // ---- US-093 / ADR 0053: interior anchor points -----------------------
  // A "part" name is either one of the fixed fields (start/end/control1/
  // control2/midPoint/midHandleIn/midHandleOut) or "point<i>.point" /
  // "point<i>.handleIn" / "point<i>.handleOut" addressing ann.points[i]. This
  // is the one place that parses that name, so drag/nudge/readout/delete code
  // never has to know the string format.
  const CURVE_ANCHOR_PART_RE = /^point(\d+)\.(point|handleIn|handleOut)$/;

  function parseCurveAnchorPart(part) {
    const m = typeof part === 'string' && part.match(CURVE_ANCHOR_PART_RE);
    return m ? { index: Number(m[1]), field: m[2] } : null;
  }

  // Read the world position addressed by any annotation "part" name, fixed
  // field or interior anchor alike — the one generic getter drag/nudge/readout
  // code should use instead of `ann[part]` (which cannot address an anchor).
  function getAnnPartPoint(ann, part) {
    if (!ann || !part) return null;
    const anchor = parseCurveAnchorPart(part);
    if (anchor) {
      const pt = ann.points && ann.points[anchor.index];
      return pt ? pt[anchor.field] || null : null;
    }
    return ann[part] || null;
  }

  // Keep an interior anchor's two handles collinear through its point (a
  // "smooth" anchor, the TD's default per ADR 0053) by re-angling the handle
  // that was NOT just dragged to point the opposite way, preserving that
  // handle's own current distance from the point — only the angle is forced,
  // not the length. Called on every plain drag, never stored, so an anchor
  // whose pairing was broken with Alt re-smooths itself the moment either
  // handle is dragged normally again.
  function mirrorOppositeCurveHandle(pt, draggedField) {
    const otherField = draggedField === 'handleIn' ? 'handleOut' : 'handleIn';
    const other = pt[otherField];
    const dragged = pt[draggedField];
    if (!other || !dragged || !pt.point) return;
    const dx = dragged.x - pt.point.x;
    const dy = dragged.y - pt.point.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const otherLen = Math.hypot(other.x - pt.point.x, other.y - pt.point.y);
    pt[otherField] = {
      x: pt.point.x - (dx / len) * otherLen,
      y: pt.point.y - (dy / len) * otherLen,
    };
  }

  // De Casteljau subdivision of a cubic Bézier at parameter t — splits one
  // curve into two that together trace the EXACT same path, which is what
  // lets "Add point" insert an anchor without changing the curve's shape.
  function subdivideCubicBezier(p0, p1, p2, p3, t) {
    const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const p01 = lerp(p0, p1), p12 = lerp(p1, p2), p23 = lerp(p2, p3);
    const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
    const p0123 = lerp(p012, p123);
    return { left: [p0, p01, p012, p0123], right: [p0123, p123, p23, p3] };
  }

  // How far (world px) a sampled chord is allowed to depart from the curve it
  // stands in for. US-093 / ADR 0053 code review, 2026-08-21: this is the
  // accuracy budget of the "Add point" hit test, and it is expressed in WORLD
  // px on purpose — it has no zoom term, so it stays far below
  // handleAddPointClick's 8/state.zoom tolerance however far the TD zooms in.
  const CURVE_CHORD_TOLERANCE = 0.05;
  const CURVE_CHORD_MIN_SAMPLES = 24;
  const CURVE_CHORD_MAX_SAMPLES = 512;

  // Chord count for approximating one cubic, chosen so the chord never departs
  // from the curve by more than CURVE_CHORD_TOLERANCE. Standard flatness
  // bound: over a parameter width Δ, |curve − chord| ≤ (Δ²/8)·max|B''|, and
  // for a cubic max|B''| = 6·max(|p0−2p1+p2|, |p1−2p2+p3|). Setting Δ = 1/n
  // and solving gives the count below, so accuracy is driven by the curve's
  // actual bend rather than by a fixed number that a long curve outgrows.
  function curveChordSampleCount(seg) {
    const ax = seg.p0.x - 2 * seg.p1.x + seg.p2.x;
    const ay = seg.p0.y - 2 * seg.p1.y + seg.p2.y;
    const bx = seg.p1.x - 2 * seg.p2.x + seg.p3.x;
    const by = seg.p1.y - 2 * seg.p2.y + seg.p3.y;
    const maxSecond = 6 * Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
    const n = Math.ceil(Math.sqrt(maxSecond / (8 * CURVE_CHORD_TOLERANCE)));
    // Floor 24 matches the old fixed sample count, so nothing about WHERE an
    // anchor lands got coarser for a short curve. Cap 512 bounds the work for
    // an absurd or corrupt curve — a once-per-click handler can spend 512
    // Bézier evaluations without anyone noticing.
    return clamp(
      Number.isFinite(n) ? n : CURVE_CHORD_MIN_SAMPLES,
      CURVE_CHORD_MIN_SAMPLES,
      CURVE_CHORD_MAX_SAMPLES,
    );
  }

  // Find the closest point ON a selected curve to a click, for the "Add
  // point" tool — insertion always lands on the curve's actual path, at the
  // nearest position, never at the raw click pixel.
  //
  // US-093 / ADR 0053 code review, 2026-08-21: this used to compare the click
  // against 25 sampled VERTICES per segment, which silently rejected a dead-on
  // click on any long or zoomed-in curve. Worst-case distance from an
  // exactly-on-path click to the nearest VERTEX is half the sample spacing —
  // arcLength/48 — so a 400-world-px armhole curve reported 8.3px against
  // handleAddPointClick's 8px tolerance and the click did nothing at all.
  // Zooming in to place a bend precisely made it worse, not better: the
  // tolerance shrinks as 8/state.zoom while vertex spacing does not.
  //
  // The fix is the one isPointNearAnnotation (src/render/hit-testing.js)
  // already relies on — measure against the polyline SEGMENTS, so accuracy is
  // bounded by chord flatness instead of by sample spacing. `t` is then
  // recovered inside the winning chord from the projection parameter, so the
  // anchor still lands ON the path. Insertion is lossless at ANY t (de
  // Casteljau subdivision preserves the path exactly), so sub-sample t
  // precision decides only WHERE the anchor sits, never the curve's shape.
  function nearestPointOnCurve(ann, world) {
    const segs = getCurveBeziers(ann);
    let best = null;
    for (let s = 0; s < segs.length; s += 1) {
      const seg = segs[s];
      const samples = curveChordSampleCount(seg);
      let prev = seg.p0;
      for (let i = 1; i <= samples; i += 1) {
        const next = bezierPoint(seg.p0, seg.p1, seg.p2, seg.p3, i / samples);
        const d = pointToSegmentDistance(world, prev, next);
        if (!best || d < best.distance) {
          best = { seg, segIndex: s, samples, index: i, a: prev, b: next, distance: d };
        }
        prev = next;
      }
    }
    if (!best) return null;
    // Recover t inside the winning chord with the same clamped projection
    // parameter pointToSegmentDistance computes internally, then report the
    // point that parameter names on the CURVE (not on the chord) so the
    // caller's insertion — and the endpoint-proximity gate in front of it —
    // both work against the drawn path.
    const dx = best.b.x - best.a.x;
    const dy = best.b.y - best.a.y;
    const l2 = dx * dx + dy * dy;
    const u = l2 === 0 ? 0
      : clamp(((world.x - best.a.x) * dx + (world.y - best.a.y) * dy) / l2, 0, 1);
    const t = (best.index - 1 + u) / best.samples;
    const seg = best.seg;
    return {
      segIndex: best.segIndex,
      t,
      point: bezierPoint(seg.p0, seg.p1, seg.p2, seg.p3, t),
      distance: best.distance,
    };
  }

  // Dry-run an insertion at (segIndex, t) — subdivideCubicBezier is pure, so
  // the exact geometry insertCurveAnchorAt would write can be inspected before
  // anything is mutated. Returns null when the arguments name no split this
  // curve can take. US-093 / ADR 0053 code review, 2026-08-21.
  //
  // `minHandleSpan` is the shortest distance any of the four handles the split
  // rewrites would end up from the point it bends: the outer handle left behind
  // on the near side (left[1], off p0), the new anchor's own handleIn/handleOut
  // (left[2] / right[1], off the new point), and the outer handle on the far
  // side (right[2], off p3). handleAddPointClick's gate bounds exactly that, so
  // no caller has to relate handle clearance to anchor clearance — the ratio
  // between them is a property of this curve's control points, not a constant.
  function previewCurveAnchorInsertion(ann, segIndex, t) {
    if (!ann || ann.type !== 'curved') return null;
    const points = Array.isArray(ann.points) ? ann.points : [];
    // `segIndex` addresses getCurveBeziers' segment list, which is
    // points.length + 1 long, so anything outside [0, points.length] reads
    // points[-1] or points[points.length] and throws on `.point` / `.handleOut`.
    // That is reachable in principle, not just in theory: getCurveBeziers
    // returns TWO segments for a legacy midPoint curve while `points` is still
    // empty, so nearestPointOnCurve can hand back segIndex 1 against
    // points.length 0. No live path does today — ensureCurveControls collapses
    // midPoint on load, history restore, paste and apply, and
    // createCurvedAnnotation is born with midPoint: null — but the guard costs
    // one comparison and removes the dependency. The integer test is part of
    // the bound rather than decoration: NaN passes both range comparisons and
    // would reach points[NaN - 1].
    if (!Number.isInteger(segIndex) || segIndex < 0 || segIndex > points.length) return null;
    // t must not be exactly 0 or 1: subdivideCubicBezier then returns
    // left = [p0, p0, p0, p0] (mirrored at 1), so the split would drop
    // ann.control1 onto ann.start and put the new anchor there too, with a
    // zero-length handleIn that mirrorOppositeCurveHandle can never re-smooth
    // (it rebuilds the opposite handle at its OWN current length, and that
    // length is 0), while drawArrowheadsForCurve takes atan2(0, 0) and snaps
    // the start arrowhead to +x. Coincident points also lose every hit test to
    // the endpoint (hit-testing.js's `<=` tie rule), so that bend would be
    // gone for good. All of it is strictly a t === 0 / t === 1 hazard — for any
    // t > 0 the split control lies ON the p0->p1 segment, keeping the arrowhead
    // angle exact and both new handles proportional to t — so 1e-3 suffices
    // here. How SHORT a handle may get is `minHandleSpan` and the caller's
    // gate, not this clamp.
    const tSafe = clamp(Number.isFinite(t) ? t : 0.5, 1e-3, 1 - 1e-3);
    const p0 = segIndex === 0 ? ann.start : points[segIndex - 1].point;
    const before = segIndex === 0 ? ann.control1 : points[segIndex - 1].handleOut;
    const after = segIndex === points.length ? ann.control2 : points[segIndex].handleIn;
    const p3 = segIndex === points.length ? ann.end : points[segIndex].point;
    const { left, right } = subdivideCubicBezier(p0, before, after, p3, tSafe);
    const point = left[3];
    return {
      tSafe,
      left,
      right,
      point,
      minHandleSpan: Math.min(
        distance(left[1], p0),
        distance(left[2], point),
        distance(right[1], point),
        distance(right[2], p3),
      ),
    };
  }

  // Insert a new interior anchor by splitting segment `segIndex` (0-based,
  // matching getCurveBeziers' order) at parameter `t`. Exact — the curve's
  // drawn path is unchanged at the instant of insertion (US-093 / ADR 0053).
  // Returns the new anchor's index in ann.points, or -1 if the preview above
  // refused the arguments — in which case nothing at all was changed, ann.points
  // included. -1 can never collide with a real result, which is always the
  // accepted segIndex and therefore >= 0.
  function insertCurveAnchorAt(ann, segIndex, t) {
    const split = previewCurveAnchorInsertion(ann, segIndex, t);
    if (!split) return -1;
    const points = Array.isArray(ann.points) ? ann.points : (ann.points = []);
    const { left, right } = split;
    // Both assignments read the PRE-splice points.length, hence the splice last.
    if (segIndex === 0) ann.control1 = left[1]; else points[segIndex - 1].handleOut = left[1];
    if (segIndex === points.length) ann.control2 = right[2]; else points[segIndex].handleIn = right[2];
    points.splice(segIndex, 0, { point: split.point, handleIn: left[2], handleOut: right[1] });
    return segIndex;
  }

  // Remove one interior anchor (US-093 / ADR 0053). Unlike insertion this has
  // no exact inverse — merging two segments back into one cannot preserve
  // both exactly — so the two now-adjacent segments simply keep whatever
  // outer handles already flank the removed anchor. The TD re-drags by hand
  // if the join doesn't look right; this asymmetry (insertion is lossless,
  // deletion is not) is deliberate, not an oversight.
  function deleteCurveAnchorAt(ann, index) {
    if (!ann || !Array.isArray(ann.points)) return;
    ann.points.splice(index, 1);
  }

  // Build a smooth two-segment curve that PASSES THROUGH start, mid, end (the
  // three clicked points). Catmull-Rom with reflected endpoints: the tangent at
  // the middle is parallel to the start→end chord, so the joint stays smooth.
  function curveControlsThroughThreePoints(start, mid, end) {
    return {
      control1: { x: start.x + (mid.x - start.x) / 3, y: start.y + (mid.y - start.y) / 3 },
      midHandleIn: { x: mid.x - (end.x - start.x) / 6, y: mid.y - (end.y - start.y) / 6 },
      midPoint: { x: mid.x, y: mid.y },
      midHandleOut: { x: mid.x + (end.x - start.x) / 6, y: mid.y + (end.y - start.y) / 6 },
      control2: { x: end.x - (end.x - mid.x) / 3, y: end.y - (end.y - mid.y) / 3 },
    };
  }

  function bezierPoint(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const a = mt2 * mt;
    const b = 3 * mt2 * t;
    const c = 3 * mt * t2;
    const d = t * t2;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }

  function bezierTangent(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return {
      x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
      y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y)
    };
  }

  function createCurvedAnnotation(start, end, style, color = 'red', arrowType = 'double', lineWidth = DEFAULT_LINE_WIDTH, mid = null) {
    const id = state.idCounter++;
    // A curve is ONE cubic Bézier: two endpoints + two control handles
    // (control1 off start, control2 off end) — TD 2026-07-18, edited like a
    // standard pen tool. No middle anchor. A 3-click draw fits the single cubic
    // so it passes through the middle click at t=0.5; otherwise seed a default
    // bow. `midPoint`/`midHandleIn`/`midHandleOut` stay null.
    const midRaw = mid || defaultCurveMidPoint(start, end);
    const c = controlsFromMidPoint(start, end, midRaw);
    const label = computeDefaultLabelPosition({
      type: 'curved',
      start,
      end,
      control1: c.control1,
      control2: c.control2,
    });
    return {
      id,
      seq: state.nextSequence,
      type: 'curved',
      style,
      color,
      arrowType,
      lineWidth: normalizeLineWidth(lineWidth),
      start: clonePoint(start),
      end: clonePoint(end),
      midPoint: null,
      midHandleIn: null,
      midHandleOut: null,
      control1: c.control1,
      control2: c.control2,
      points: [], // US-093: interior anchors the TD adds later, on demand.
      label,
      labelManual: false,
      text: null,
      value: null,
    };
  }

  // Default bow when drawing a new curve — perpendicular offset matching the
  // pre-midPoint visual default, so new curves look identical.
  function defaultCurveMidPoint(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;
    const offset = clamp(len * 0.16, 26 / state.zoom, 82 / state.zoom);
    return {
      x: (start.x + end.x) / 2 + nx * offset,
      y: (start.y + end.y) / 2 + ny * offset,
    };
  }

  // Derive cubic Bézier controls so the curve passes through `midPoint` at
  // t=0.5 with tangent parallel to the chord. Place controls symmetrically
  // at the t=1/3 and t=2/3 chord positions and lift by (4/3)·(midPoint −
  // chordMid). See B(0.5) = 0.125·S + 0.375·P1 + 0.375·P2 + 0.125·E.
  function controlsFromMidPoint(start, end, midPoint) {
    const cmx = (start.x + end.x) / 2;
    const cmy = (start.y + end.y) / 2;
    const px = (4 / 3) * (midPoint.x - cmx);
    const py = (4 / 3) * (midPoint.y - cmy);
    return {
      control1: {
        x: start.x + (end.x - start.x) / 3 + px,
        y: start.y + (end.y - start.y) / 3 + py,
      },
      control2: {
        x: start.x + 2 * (end.x - start.x) / 3 + px,
        y: start.y + 2 * (end.y - start.y) / 3 + py,
      },
    };
  }

  // Normalize a curved line to the SINGLE-CUBIC model (two endpoints + two
  // control handles) — TD 2026-07-18. New curves are born single-cubic; this
  // also collapses any legacy two-segment curve (midPoint + mid handles) from
  // older saves back to one cubic. The collapse is EXACT for curves that were
  // split by deriveMidAnchor (all auto POM curves): that split set
  // control1 = mid(start, origC1), so origC1 = 2·control1 − start (and
  // symmetrically for control2), which this inverts. Then it drops the middle
  // anchor + its handles.
  function ensureCurveControls(ann) {
    if (!ann || ann.type !== 'curved' || !ann.start || !ann.end) return;
    if (ann.midPoint) {
      if (ann.control1) {
        ann.control1 = { x: 2 * ann.control1.x - ann.start.x, y: 2 * ann.control1.y - ann.start.y };
      }
      if (ann.control2) {
        ann.control2 = { x: 2 * ann.control2.x - ann.end.x, y: 2 * ann.control2.y - ann.end.y };
      }
      ann.midPoint = null;
      ann.midHandleIn = null;
      ann.midHandleOut = null;
    }
    if (!ann.control1 || !ann.control2 ||
        !Number.isFinite(ann.control1.x) || !Number.isFinite(ann.control2.x)) {
      const m0 = defaultCurveMidPoint(ann.start, ann.end);
      const c = controlsFromMidPoint(ann.start, ann.end, m0);
      ann.control1 = c.control1;
      ann.control2 = c.control2;
    }
    // US-093: a project saved before interior anchors existed has no `points`
    // at all — default it to empty rather than treating it as missing data,
    // so getCurveBeziers/getAnnPartPoint never have to null-check twice.
    //
    // US-093 / ADR 0053 code review, 2026-08-21: validate the ENTRIES too, not
    // just the array. loadProject runs arbitrary user-supplied JSON through
    // here, and ONE truncated anchor — { point: {x, y} } with no handles, from
    // a hand edit, a half-written file, or a different build — makes
    // getCurveBeziers emit a segment whose p2 is undefined, so
    // drawAnnotationPath throws on s.p2.x inside the render pass and NOTHING
    // paints; computeDefaultLabelPosition and nearestPointOnCurve dereference
    // the same fields just as unguarded. Dropping the unusable entries beats
    // throwing for the reason normalizeNote already drops an unplaceable note
    // (US-092, project-load.js): the curve still opens, measures, and exports,
    // losing only a bend the TD can re-add with "Add point", whereas a throw
    // costs the TD the entire board. Only reassign when something was actually
    // dropped, so a clean load leaves the array identity untouched.
    if (!Array.isArray(ann.points)) {
      ann.points = [];
    } else if (ann.points.length) {
      const usable = ann.points.filter(pt => pt && isFinitePoint(pt.point)
        && isFinitePoint(pt.handleIn) && isFinitePoint(pt.handleOut));
      if (usable.length !== ann.points.length) ann.points = usable;
    }
  }
