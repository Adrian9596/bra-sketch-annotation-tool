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

  // A curved line is one or two cubic Bézier segments. With a middle anchor
  // (midPoint) plus its two handles it's two segments joined there; without
  // them (older lines, in-progress drafts) it's a single segment. Everything
  // that samples, draws, or measures a curve goes through here so both shapes
  // just work.
  function getCurveBeziers(ann) {
    if (!ann || ann.type !== 'curved') return [];
    if (ann.midPoint && ann.midHandleIn && ann.midHandleOut) {
      return [
        { p0: ann.start, p1: ann.control1, p2: ann.midHandleIn, p3: ann.midPoint },
        { p0: ann.midPoint, p1: ann.midHandleOut, p2: ann.control2, p3: ann.end },
      ];
    }
    return [{ p0: ann.start, p1: ann.control1, p2: ann.control2, p3: ann.end }];
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
  }
