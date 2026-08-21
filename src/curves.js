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

  // Find the closest point ON a selected curve to a click, for the "Add
  // point" tool — insertion always lands on the curve's actual path, at the
  // nearest position, never at the raw click pixel. 24 samples per segment is
  // plenty for a click-precision UI gesture (not a measurement).
  function nearestPointOnCurve(ann, world) {
    const segs = getCurveBeziers(ann);
    let best = null;
    const SAMPLES = 24;
    for (let s = 0; s < segs.length; s += 1) {
      const seg = segs[s];
      for (let i = 0; i <= SAMPLES; i += 1) {
        const t = i / SAMPLES;
        const p = bezierPoint(seg.p0, seg.p1, seg.p2, seg.p3, t);
        const d = distance(world, p);
        if (!best || d < best.distance) best = { segIndex: s, t, point: p, distance: d };
      }
    }
    return best;
  }

  // Insert a new interior anchor by splitting segment `segIndex` (0-based,
  // matching getCurveBeziers' order) at parameter `t`. Exact — the curve's
  // drawn path is unchanged at the instant of insertion (US-093 / ADR 0053).
  // Returns the new anchor's index in ann.points.
  function insertCurveAnchorAt(ann, segIndex, t) {
    const points = Array.isArray(ann.points) ? ann.points : (ann.points = []);
    const p0 = segIndex === 0 ? ann.start : points[segIndex - 1].point;
    const before = segIndex === 0 ? ann.control1 : points[segIndex - 1].handleOut;
    const after = segIndex === points.length ? ann.control2 : points[segIndex].handleIn;
    const p3 = segIndex === points.length ? ann.end : points[segIndex].point;
    const { left, right } = subdivideCubicBezier(p0, before, after, p3, t);
    const newAnchor = { point: left[3], handleIn: left[2], handleOut: right[1] };
    if (segIndex === 0) ann.control1 = left[1]; else points[segIndex - 1].handleOut = left[1];
    if (segIndex === points.length) ann.control2 = right[2]; else points[segIndex].handleIn = right[2];
    points.splice(segIndex, 0, newAnchor);
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
    if (!Array.isArray(ann.points)) ann.points = [];
  }
