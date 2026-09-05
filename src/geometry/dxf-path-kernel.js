// US-105: DXF Pattern Measurement — the deterministic, DOM-independent
// measurement kernel. Pure functions only: no state, no DOM, no canvas. Every
// function here operates on the NATIVE (as-authored, pre-Y-flip, unscaled)
// DXF coordinate space produced by src/manual/dxf-native-parser.js — never on
// board/world/screen coordinates. Board placement, zoom and pan are display
// transforms applied only when rendering a result; they must never change a
// value this file computes.
// Source part for app.js. Run `npm run build` after editing.
//
// Segment shapes this kernel understands (the same 'straight'/'arc' shapes
// src/manual/dxf-import.js's dxfSegmentEndpoints/dxfSegmentPoints were
// extended to read for US-105 — see that file for dxfPointOnArcSegment,
// which this file calls by name; function declarations hoist across the
// whole bundle, so the load order between the two files does not matter):
//   { kind: 'straight', a: {x,y}, b: {x,y} }
//   { kind: 'arc', center: {x,y}, radius, startAngle, sweep }  (radians;
//     sweep signed, CCW positive, |sweep| < 2*PI)
//   { kind: 'curve', p0, p1, p2, p3 }  (cubic Bezier — not produced by any
//     in-scope DXF entity today; supported here only because the checklist
//     names adaptive Bezier length/projection as required kernel functions.)

  // ---- Stable reason codes (checklist P2) ------------------------------------

  const DXF_MEASURE_REASON = {
    NO_DXF_SESSION: 'NO_DXF_SESSION',
    NO_HIT: 'NO_HIT',
    NO_CONNECTED_PATH: 'NO_CONNECTED_PATH',
    AMBIGUOUS_ROUTE: 'AMBIGUOUS_ROUTE',
    ROUTE_SEARCH_TRUNCATED: 'ROUTE_SEARCH_TRUNCATED',
    UNSUPPORTED_GEOMETRY: 'UNSUPPORTED_GEOMETRY',
    NON_FINITE_GEOMETRY: 'NON_FINITE_GEOMETRY',
    // ADR 0084: A and B resolved to the same point on an OPEN path — there is
    // nothing between them to measure. (On a closed loop the same click pair
    // is a real request, "the whole way around," and yields a loop route.)
    SAME_POINT: 'SAME_POINT',
  };

  // ---- Unit conversion --------------------------------------------------------

  // Autodesk $INSUNITS codes -> multiplier to convert ONE native unit into ONE
  // inch. Only the units a real factory DXF plausibly declares are mapped;
  // every other code (including 0, "Unitless") returns null so the caller
  // falls back to the locked default-inch convention with unitSource
  // 'default-inch' rather than guessing a scale factor.
  // RB-4: code 21 (US Survey Foot) is NOT one inch — the old table mapped it
  // to a bare 1, i.e. silently treated a US Survey Foot as though it were an
  // inch (a 12x error). A US Survey Foot is legally defined as exactly
  // 1200/3937 metre (the pre-2023 US definition DXF's $INSUNITS convention
  // still assumes); dividing by the international inch (0.0254m exactly)
  // gives its correct inch-equivalent, computed here as an exact fraction
  // (~= 12.0000240000048) rather than a rounded literal, so "every accepted
  // $INSUNITS conversion is correct" holds to full float precision instead of
  // accepting a 0.002%-off approximation.
  const DXF_US_SURVEY_FOOT_IN_INCHES = (1200 / 3937) / 0.0254;

  const DXF_INSUNITS_TO_INCH = {
    1: 1,                              // Inches
    2: 12,                             // Feet
    4: 1 / 25.4,                       // Millimeters
    5: 1 / 2.54,                       // Centimeters
    6: 39.3700787402,                  // Meters
    21: DXF_US_SURVEY_FOOT_IN_INCHES,  // US Survey Feet
  };

  function dxfUnitCodeToInchFactor(code) {
    const n = Number(code);
    return Object.prototype.hasOwnProperty.call(DXF_INSUNITS_TO_INCH, n) ? DXF_INSUNITS_TO_INCH[n] : null;
  }

  // Resolves the {factor, unitSource, diagnostic} triple the session model
  // stamps onto every length it reports. `insunits` is whatever
  // dxf-native-parser.js's header read returned (a numeric code, or
  // null/undefined when no usable declaration exists).
  //
  // RB-4: "missing" (no $INSUNITS at all) and "present but not one of the
  // codes this tool supports" are DIFFERENT situations and must not share a
  // provenance label — the old code silently folded both into
  // 'default-inch', which reads as "this file simply had no units," even for
  // a file that explicitly declared, say, miles or kilometres. Both still
  // fall back to the same locked default-inch factor (an unconfirmed guess is
  // still the least-wrong default for this factory workflow), but an explicit
  // unsupported code gets its own unitSource plus a diagnostic naming the
  // code, so nothing downstream can mistake "we don't support this" for "the
  // header conversion was applied correctly."
  function dxfResolveNativeToInch(insunits) {
    if (insunits == null) return { factor: 1, unitSource: 'default-inch', diagnostic: null };
    const factor = dxfUnitCodeToInchFactor(insunits);
    if (factor != null) return { factor, unitSource: 'dxf-header', diagnostic: null };
    return {
      factor: 1,
      unitSource: 'unsupported-explicit-unit',
      diagnostic: {
        code: insunits,
        message: 'DXF declares $INSUNITS=' + insunits + ', which this tool does not recognize. '
          + 'Falling back to inches (unconfirmed) rather than guessing a conversion factor.',
      },
    };
  }

  // ---- US-126: geometry-based unit inference ---------------------------------
  //
  // Most factory pattern DXFs do not declare $INSUNITS at all. Measured on the
  // real corpus (demo/DXF file/dxf): 31 of 41 files carry no unit header, and
  // the locked default-inch fallback silently reports every millimetre file
  // 25.4x too small — "thông số không chính xác" (the numbers are wrong), with
  // no way for the TD to know which files were affected.
  //
  // A pattern piece is a physical object, so its size is itself evidence. The
  // two units pattern CAD actually exports are inches and millimetres, and
  // they are 25.4x apart — far wider than the spread of real garment piece
  // sizes — so a robust size statistic separates them cleanly. Corroborated on
  // the corpus: the 9 files that DO declare $INSUNITS=4 (mm) have a median
  // piece diagonal of 243-285 native units, and every un-declared file lands
  // either in that same band (165-1110, all genuinely mm) or an order of
  // magnitude lower (4-18, all genuinely inches — verified against raw
  // coordinates in SE0015-COSTING.dxf, an ASTM/AAMA inch export). Nothing in
  // the corpus falls in the gap between.
  //
  // Deliberately NOT offered as a candidate: centimetres. A cm reading is
  // never separable from an inch reading by size alone (they are 2.54x apart,
  // inside the spread of real piece sizes), and no pattern CAD in this
  // workflow exports cm — guessing it would trade a detectable error for an
  // undetectable one. A file whose evidence fits BOTH candidates, or neither,
  // infers nothing and keeps the honest "assumed" provenance.
  const DXF_UNIT_INFERENCE_CANDIDATES = [
    { key: 'in', factor: 1 },
    { key: 'mm', factor: 1 / 25.4 },
  ];
  // Plausible inches for ONE pattern piece's bounding-box diagonal, and for
  // the whole drawing's. Both must hold for a candidate to be accepted, so a
  // file of tiny trim pieces cannot be read as inches on the strength of the
  // piece statistic alone.
  const DXF_UNIT_PIECE_DIAG_IN = { min: 1, max: 80 };
  const DXF_UNIT_EXTENT_DIAG_IN = { min: 2, max: 400 };

  function dxfMedian(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // `pieces`: [{ segments }] exactly as parseDxfNativeModel builds them.
  // Returns { key, factor, medianPieceDiag, extentDiag } for a single
  // unambiguous fit, or null when the evidence fits both candidates or
  // neither (in which case the caller keeps its own fallback and says so).
  //
  // The MEDIAN piece diagonal, not the mean or the extremes: a real file is
  // full of one-line notches, drill marks and stray far-away entities (one
  // corpus file has a single piece 592,094 units across next to a median of
  // 8.5), and a statistic those can move is not evidence.
  function dxfInferUnitFromGeometry(pieces) {
    if (!Array.isArray(pieces) || !pieces.length) return null;
    const diagonals = [];
    // The whole drawing's extent is the UNION of the per-piece boxes — the
    // pieces partition the segments, so this is exactly the box
    // dxfBoundsOfSegments would return over every segment at once, without
    // building that combined array (which was O(pieces * segments) of pure
    // copying on a 108-piece file, for a bound already in hand).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const piece of pieces) {
      const segments = piece && Array.isArray(piece.segments) ? piece.segments : null;
      if (!segments || !segments.length) continue;
      const bounds = dxfBoundsOfSegments(segments);
      const diagonal = Math.hypot(bounds.width, bounds.height);
      if (Number.isFinite(diagonal) && diagonal > 0) diagonals.push(diagonal);
      if (bounds.x < minX) minX = bounds.x;
      if (bounds.y < minY) minY = bounds.y;
      if (bounds.x + bounds.width > maxX) maxX = bounds.x + bounds.width;
      if (bounds.y + bounds.height > maxY) maxY = bounds.y + bounds.height;
    }
    if (!diagonals.length || !Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    const median = dxfMedian(diagonals);
    const extent = Math.hypot(maxX - minX, maxY - minY);
    if (!Number.isFinite(median) || !(median > 0) || !Number.isFinite(extent) || !(extent > 0)) return null;
    const fits = DXF_UNIT_INFERENCE_CANDIDATES.filter((candidate) => {
      const pieceIn = median * candidate.factor;
      const extentIn = extent * candidate.factor;
      return pieceIn >= DXF_UNIT_PIECE_DIAG_IN.min && pieceIn <= DXF_UNIT_PIECE_DIAG_IN.max
        && extentIn >= DXF_UNIT_EXTENT_DIAG_IN.min && extentIn <= DXF_UNIT_EXTENT_DIAG_IN.max;
    });
    if (fits.length !== 1) return null;
    return { key: fits[0].key, factor: fits[0].factor, medianPieceDiag: median, extentDiag: extent };
  }

  // ---- Point-at-parameter / length, per segment kind -------------------------

  function dxfPointOnSegment(seg, t) {
    if (!seg) return null;
    if (seg.kind === 'straight') {
      return { x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t };
    }
    if (seg.kind === 'arc') return dxfPointOnArcSegment(seg, t);
    if (seg.kind === 'curve') return bezierPoint(seg.p0, seg.p1, seg.p2, seg.p3, t);
    return null;
  }

  // Adaptive cubic Bézier length (Gravesen's method): a segment whose chord
  // and control-polygon lengths already agree within `tolerance` is flat
  // enough to report their average; otherwise split at t=0.5 (exact, via
  // curves.js's subdivideCubicBezier) and recurse on each half. Depth-capped
  // defensively — 24 halvings is already far past any tolerance this kernel's
  // 0.01mm-equivalent native budget would ever demand — so a degenerate
  // (self-intersecting or absurdly long) curve cannot spin forever.
  function dxfBezierSegmentLength(p0, p1, p2, p3, tolerance, depth) {
    const chord = distance(p0, p3);
    const poly = distance(p0, p1) + distance(p1, p2) + distance(p2, p3);
    if (poly - chord <= tolerance || (depth || 0) >= 24) return (chord + poly) / 2;
    const split = subdivideCubicBezier(p0, p1, p2, p3, 0.5);
    return dxfBezierSegmentLength(split.left[0], split.left[1], split.left[2], split.left[3], tolerance, (depth || 0) + 1)
      + dxfBezierSegmentLength(split.right[0], split.right[1], split.right[2], split.right[3], tolerance, (depth || 0) + 1);
  }

  // Exact De Casteljau extraction of the [t0,t1] portion of one cubic —
  // split at t1 first (keep the [0,t1] side), then re-split that side at the
  // LOCAL parameter t0/t1 (keep the far side), which is exactly [t0,t1] in
  // the curve's original parametrization.
  function dxfBezierSubcurve(p0, p1, p2, p3, t0, t1) {
    if (!(t1 > 1e-12)) return [p0, p0, p0, p0];
    const outer = subdivideCubicBezier(p0, p1, p2, p3, clamp(t1, 0, 1));
    const localT0 = clamp(t0 / t1, 0, 1);
    const inner = subdivideCubicBezier(outer.left[0], outer.left[1], outer.left[2], outer.left[3], localT0);
    return inner.right;
  }

  const DXF_BEZIER_DEFAULT_TOLERANCE = 1e-6;

  function dxfSegmentFailureReason(seg) {
    if (!seg || typeof seg !== 'object') return DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY;
    const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    if (seg.kind === 'straight') {
      if (!finitePoint(seg.a) || !finitePoint(seg.b)) return DXF_MEASURE_REASON.NON_FINITE_GEOMETRY;
      if (!(distance(seg.a, seg.b) > 0)) return DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY;
      return null;
    }
    if (seg.kind === 'arc') {
      if (!finitePoint(seg.center) || !Number.isFinite(seg.radius)
        || !Number.isFinite(seg.startAngle) || !Number.isFinite(seg.sweep)) {
        return DXF_MEASURE_REASON.NON_FINITE_GEOMETRY;
      }
      if (!(seg.radius > 0) || !(Math.abs(seg.sweep) > 1e-12)
        || Math.abs(seg.sweep) > Math.PI * 2 + 1e-9) {
        return DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY;
      }
      return null;
    }
    if (seg.kind === 'curve') {
      if (![seg.p0, seg.p1, seg.p2, seg.p3].every(finitePoint)) return DXF_MEASURE_REASON.NON_FINITE_GEOMETRY;
      const controlLength = distance(seg.p0, seg.p1) + distance(seg.p1, seg.p2) + distance(seg.p2, seg.p3);
      if (!(controlLength > 0)) return DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY;
      return null;
    }
    return DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY;
  }

  // RB-4: an invalid/unrecognized segment reports NaN, never a plausible 0 —
  // 0 is a legitimate-looking length that would silently under-count a route
  // sum (dxfRouteLength's reduce below); NaN poisons that same sum instead
  // (NaN + anything === NaN) and dxfMeasureValueInches's existing
  // Number.isFinite guard already turns that into "no value" (rendered "—"),
  // so the caller sees an honest failure, not a wrong number.
  function dxfSegmentLength(seg, tolerance) {
    if (dxfSegmentFailureReason(seg)) return NaN;
    if (seg.kind === 'straight') return distance(seg.a, seg.b);
    if (seg.kind === 'arc') return Math.abs(seg.sweep) * seg.radius;
    if (seg.kind === 'curve') {
      return dxfBezierSegmentLength(seg.p0, seg.p1, seg.p2, seg.p3, tolerance || DXF_BEZIER_DEFAULT_TOLERANCE, 0);
    }
    return NaN;
  }

  // Length of the portion of `seg` between parameters t0 and t1 (t0 may be
  // greater than t1 — the caller decides direction; the returned length is
  // always the unsigned length of that portion). Straight/arc are affinely
  // parametrized (length is linear in t), so the partial length is exact and
  // analytic; a curve is subdivided first via dxfBezierSubcurve, then
  // measured with the same adaptive integrator as the full-curve case.
  // RB-4: same NaN-not-0 contract as dxfSegmentLength, for the same reason.
  function dxfPartialLength(seg, t0, t1, tolerance) {
    if (dxfSegmentFailureReason(seg) || !Number.isFinite(t0) || !Number.isFinite(t1)
      || t0 < -1e-9 || t0 > 1 + 1e-9 || t1 < -1e-9 || t1 > 1 + 1e-9) return NaN;
    const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    if (seg.kind === 'straight' || seg.kind === 'arc') {
      return dxfSegmentLength(seg, tolerance) * (hi - lo);
    }
    if (seg.kind === 'curve') {
      const sub = dxfBezierSubcurve(seg.p0, seg.p1, seg.p2, seg.p3, lo, hi);
      return dxfBezierSegmentLength(sub[0], sub[1], sub[2], sub[3], tolerance || DXF_BEZIER_DEFAULT_TOLERANCE, 0);
    }
    return NaN;
  }

  // ---- Point projection (nearest parameter on one segment) -------------------

  function dxfProjectPointOnStraight(point, seg) {
    const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : clamp(((point.x - seg.a.x) * dx + (point.y - seg.a.y) * dy) / l2, 0, 1);
    const p = { x: seg.a.x + t * dx, y: seg.a.y + t * dy };
    return { t, point: p, distance: distance(point, p) };
  }

  // Signed parameter of `angle` along an arc's own sweep direction, BEFORE
  // clamping to [0,1] — used to find where a point's angle (as seen from the
  // arc's center) falls relative to the swept range, in whichever rotational
  // sense (CW/CCW) the arc's own signed `sweep` runs.
  //
  // RB-4 fix: the mod-2*PI normalization first brings `delta` into [0, 2*PI),
  // then (for a clockwise, sweep<0, arc) shifts the WHOLE range down by
  // 2*PI to land in (-2*PI, 0]. That shift is correct for every angle
  // strictly inside the swept range, but it is WRONG at the exact arc start
  // (angle === startAngle, so raw delta === 0): normalizing 0 into [0,2*PI)
  // leaves it at 0 (already the correct, in-range value — the arc's own
  // valid delta range for sweep<0 is [sweep, 0], and 0 is its own upper
  // bound), but the unconditional "-= twoPi" then drags it all the way to
  // -2*PI, i.e. a param far outside [sweep,0] that dxfProjectPointOnArc's
  // clamp(...,0,1) rounds up to t=1 — the OPPOSITE endpoint. A real DXF arc's
  // sweep is always |sweep| < 2*PI (never a full loop back to its own
  // start), so delta===0 after the mod-normalize can only mean "exactly at
  // the start," never "one full lap later" — safe to special-case rather
  // than shift it.
  function dxfAngleParamOnSweep(angle, startAngle, sweep) {
    if (!sweep) return 0;
    const twoPi = Math.PI * 2;
    let delta = angle - startAngle;
    delta -= twoPi * Math.floor(delta / twoPi); // now in [0, 2*PI)
    if (sweep < 0 && delta > 0) delta -= twoPi; // now in (-2*PI, 0]; delta===0 stays 0 (the arc's own start)
    return delta / sweep;
  }

  function dxfProjectPointOnArc(point, seg) {
    const rawAngle = Math.atan2(point.y - seg.center.y, point.x - seg.center.x);
    const t = clamp(dxfAngleParamOnSweep(rawAngle, seg.startAngle, seg.sweep), 0, 1);
    const p = dxfPointOnArcSegment(seg, t);
    return { t, point: p, distance: distance(point, p) };
  }

  // First derivative of a cubic Bézier at t (a 2D vector, not a point).
  function dxfBezierDerivative(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return {
      x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
      y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
    };
  }

  // Second derivative of a cubic Bézier at t.
  function dxfBezierSecondDerivative(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return {
      x: 6 * mt * (p2.x - 2 * p1.x + p0.x) + 6 * t * (p3.x - 2 * p2.x + p1.x),
      y: 6 * mt * (p2.y - 2 * p1.y + p0.y) + 6 * t * (p3.y - 2 * p2.y + p1.y),
    };
  }

  // RB-4: chord sampling (below) only LOCALIZES a starting `t` — its sample
  // count (curveChordSampleCount) is calibrated for on-screen WORLD-px hit
  // testing (CURVE_CHORD_TOLERANCE, curves.js), which is nowhere near this
  // kernel's own 0.01mm-equivalent native budget once native units are
  // anything coarser than a small fraction of a px-in-world-units (e.g. one
  // native unit = one inch or one metre). Refines the chord estimate with
  // Newton's method on f(t) = |B(t) - point|^2 (root of f'(t) = 2(B(t)-point)
  // . B'(t)), which for a smooth cubic converges to native machine precision
  // in a handful of steps regardless of native unit scale — no in-scope DXF
  // entity produces a 'curve' segment today (see file header), but the
  // checklist names adaptive Bézier projection as a required kernel
  // primitive, so this stays unit-agnostic rather than reusing a world-px
  // tolerance as measurement authority (the same mistake RB-4 flags for the
  // topology merge tolerance).
  function dxfRefineBezierProjectionT(point, p0, p1, p2, p3, t0) {
    let t = clamp(t0, 0, 1);
    for (let i = 0; i < 8; i += 1) {
      const b = bezierPoint(p0, p1, p2, p3, t);
      const d1 = dxfBezierDerivative(p0, p1, p2, p3, t);
      const d2 = dxfBezierSecondDerivative(p0, p1, p2, p3, t);
      const ex = b.x - point.x, ey = b.y - point.y;
      const fPrime = 2 * (ex * d1.x + ey * d1.y);
      const fDoublePrime = 2 * (d1.x * d1.x + d1.y * d1.y + ex * d2.x + ey * d2.y);
      if (!Number.isFinite(fPrime) || !Number.isFinite(fDoublePrime) || Math.abs(fDoublePrime) < 1e-12) break;
      const next = clamp(t - fPrime / fDoublePrime, 0, 1);
      if (Math.abs(next - t) < 1e-13) { t = next; break; }
      t = next;
    }
    return t;
  }

  // Same sampled-chord technique as curves.js's nearestPointOnCurve for a
  // starting estimate, but against a bare {p0,p1,p2,p3} tuple rather than a
  // live board annotation, then refined by Newton's method
  // (dxfRefineBezierProjectionT) so the reported distance is measured
  // against the EXACT returned curve point, not the coarser sampled chord —
  // a sampled chord distance is not sufficient CAD evidence (checklist RB-4).
  function dxfProjectPointOnBezier(point, seg) {
    const samples = curveChordSampleCount(seg);
    let best = null;
    let prev = seg.p0;
    for (let i = 1; i <= samples; i += 1) {
      const next = bezierPoint(seg.p0, seg.p1, seg.p2, seg.p3, i / samples);
      const d = pointToSegmentDistance(point, prev, next);
      if (!best || d < best.distance) best = { a: prev, b: next, index: i, distance: d };
      prev = next;
    }
    if (!best) return { t: 0, point: clonePoint(seg.p0), distance: distance(point, seg.p0) };
    const dx = best.b.x - best.a.x, dy = best.b.y - best.a.y;
    const l2 = dx * dx + dy * dy;
    const u = l2 === 0 ? 0 : clamp(((point.x - best.a.x) * dx + (point.y - best.a.y) * dy) / l2, 0, 1);
    const t0 = (best.index - 1 + u) / samples;
    const t = dxfRefineBezierProjectionT(point, seg.p0, seg.p1, seg.p2, seg.p3, t0);
    const exact = bezierPoint(seg.p0, seg.p1, seg.p2, seg.p3, t);
    return { t, point: exact, distance: distance(point, exact) };
  }

  function dxfProjectPointOnSegment(point, seg) {
    if (!point || dxfSegmentFailureReason(seg) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    if (seg.kind === 'straight') return dxfProjectPointOnStraight(point, seg);
    if (seg.kind === 'arc') return dxfProjectPointOnArc(point, seg);
    if (seg.kind === 'curve') return dxfProjectPointOnBezier(point, seg);
    return null;
  }

  // ---- Direct (Out of Path) distance -----------------------------------------

  // Deliberately symmetric and deliberately not "smart" — a straight ruler
  // distance between two native points, independent of any path.
  function dxfDirectDistance(a, b) {
    if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) {
      return null;
    }
    return distance(a, b);
  }

  // ---- Connected path graph + route enumeration (Along Path) ----------------

  // Endpoints of a native segment, in AUTHORED (t=0 -> t=1) order. Reuses
  // dxf-import.js's dxfSegmentEndpoints for 'straight'/'arc' (both already
  // extended for US-105); handled directly here for 'curve' since dxf-import
  // never produces that kind and has no case for it.
  function dxfSegmentGraphEndpoints(seg) {
    if (seg.kind === 'curve') return [seg.p0, seg.p3];
    return dxfSegmentEndpoints(seg);
  }

  // RB-4: dxf-import.js's dxfConnectedComponents tolerance (0.0001 * the
  // drawing's own bounding-box diagonal) is a VISUAL/piece-grouping
  // tolerance — right for deciding "does this mark belong to that panel," but
  // wrong as measurement-topology authority: for a large native drawing (say
  // a 40-inch-diagonal pattern) it is nearly 0.004in wide, an order of
  // magnitude looser than this kernel's own 0.01mm internal budget, so it
  // could connect two endpoints a real factory pattern intends to keep
  // separate. dxfEnumerateRoutes always passes an explicit, unit-aware
  // `nodeTolerance` (derived from the session's own native-to-inch factor —
  // see dxf-measure-session.js's dxfMeasureTopologyToleranceNative) computed
  // so its worst-case conversion to mm stays inside that budget; the
  // relative-diagonal fallback below only serves the standalone kernel
  // self-test entry point and any caller that has no unit context at all.
  function dxfDefaultTopologyTolerance(segments) {
    // ADR 0084: the PAINTED extent (dxfSegmentPoints — a full circle's own
    // bounding box, a curve's handles), not the endpoints' extent. A piece
    // that is one full circle has two endpoints ~1e-15 apart: an endpoint
    // bbox gives a diagonal of ~1e-15 (not 0, so the `|| 1` fallback never
    // fires) and a tolerance of ~1e-19 — smaller than the floating-point gap
    // between those two endpoints, which then never cluster into one node,
    // and the loop is silently an open dangling edge.
    const bbox = dxfBoundsOfSegments(segments);
    const diag = Math.hypot(bbox.width, bbox.height) || 1;
    return 0.0001 * diag;
  }

  // Builds the node/edge graph for one set of native segments (typically one
  // piece, or one connected component within a piece — the caller decides;
  // this function does not assume or require connectivity, and a request
  // that ultimately cannot connect A to B simply finds no route). `tolerance`
  // is an ABSOLUTE native-unit distance (see dxfDefaultTopologyTolerance's
  // comment for why this must not default to a visual/grouping tolerance).
  function dxfBuildPathGraph(segments, tolerance) {
    if (!Array.isArray(segments) || !segments.length) return null;
    if (segments.some(dxfSegmentFailureReason)) return null;
    const allPoints = segments.flatMap(dxfSegmentGraphEndpoints);
    for (const p of allPoints) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : dxfDefaultTopologyTolerance(segments);
    const nodePoints = [];
    function findOrCreateNode(pt) {
      for (let i = 0; i < nodePoints.length; i += 1) {
        if (distance(nodePoints[i], pt) <= tol) return i;
      }
      nodePoints.push(pt);
      return nodePoints.length - 1;
    }
    const edges = segments.map((seg, segIndex) => {
      const [p0, p1] = dxfSegmentGraphEndpoints(seg);
      const nodeA = findOrCreateNode(p0);
      const nodeB = findOrCreateNode(p1);
      return { id: segIndex, segIndex, seg, t0: 0, t1: 1, nodeA, nodeB, length: dxfSegmentLength(seg) };
    });
    return {
      nodes: nodePoints.map((point, id) => ({ id, point })),
      edges,
    };
  }

  // Splits whichever CURRENT work-edge covers native segment `segIndex` at
  // parameter `t` into two, inserting a new node at that point — or, if `t`
  // already sits at that edge's own t0/t1 (within epsilon), simply returns
  // the existing node there rather than creating a zero-length edge. Mutates
  // `work` in place. Returns the node id at that point, or null if `segIndex`
  // is not covered by any current edge (should not happen for a validated
  // in-range ref against the graph's own segment list).
  function dxfInsertPointRefIntoGraph(work, ref) {
    const eps = 1e-9;
    const idx = work.edges.findIndex(e => e.segIndex === ref.segIndex && ref.t >= e.t0 - eps && ref.t <= e.t1 + eps);
    if (idx === -1) return null;
    const edge = work.edges[idx];
    const t = clamp(ref.t, edge.t0, edge.t1);
    if (t <= edge.t0 + eps) return edge.nodeA;
    if (t >= edge.t1 - eps) return edge.nodeB;
    const point = dxfPointOnSegment(edge.seg, t);
    const newNodeId = work.nextNodeId;
    work.nextNodeId += 1;
    work.nodes.push({ id: newNodeId, point });
    const lengthA = dxfPartialLength(edge.seg, edge.t0, t);
    const lengthB = dxfPartialLength(edge.seg, t, edge.t1);
    const edgeA = { id: work.nextEdgeId, segIndex: edge.segIndex, seg: edge.seg, t0: edge.t0, t1: t, nodeA: edge.nodeA, nodeB: newNodeId, length: lengthA };
    work.nextEdgeId += 1;
    const edgeB = { id: work.nextEdgeId, segIndex: edge.segIndex, seg: edge.seg, t0: t, t1: edge.t1, nodeA: newNodeId, nodeB: edge.nodeB, length: lengthB };
    work.nextEdgeId += 1;
    work.edges.splice(idx, 1, edgeA, edgeB);
    return newNodeId;
  }

  // ADR 0073: collapse EXACT-duplicate parallel edges before route search.
  // Real factory exports draw the same contour several times over (verified
  // raw: `BiancaBra v.A 1.0_Pattern.dxf`'s block `11_22_M` traces one small
  // rectangle as 4 stacked POLYLINEs — 4 identical copies of every edge).
  // Those copies land as parallel edges between the same two graph nodes,
  // and the simple-path DFS then multiplies candidates by (copies)^(hops) —
  // even a 16-segment piece blows straight through both search caps and
  // Along Path reports ROUTE_SEARCH_TRUNCATED on a trivially measurable
  // shape. A line drawn four times is still ONE path on the factory floor,
  // so keeping a single representative is the measurement-true behavior,
  // not a shortcut. Deliberately narrow: only edges between the SAME node
  // pair, same kind, same length (and for arcs the same circle + |sweep|)
  // collapse — a genuinely different second path between the same two
  // points (e.g. the two arcs of a lens) differs in geometry and survives.
  // Self-loop edges (nodeA === nodeB, e.g. full circles) are skipped: the
  // node-pair key cannot express their traversal direction, and parallel
  // self-loops never feed the DFS explosion anyway (a loop edge cannot
  // advance a simple path).
  //
  // `refs` (the A/B point references, in segIndex space) are remapped in
  // place when their own segment's edge was one of the dropped copies —
  // onto the kept representative, with t flipped when the copy was authored
  // in the opposite direction (for a straight or an arc with equal |sweep|,
  // the point at t on the reversed copy is the point at 1-t on the kept one,
  // exactly).
  function dxfCollapseDuplicateParallelEdges(work, refs, tol) {
    const groups = new Map();
    const kept = [];
    const remap = new Map();
    let collapsed = 0;
    for (const e of work.edges) {
      if (e.nodeA === e.nodeB) { kept.push(e); continue; }
      const pairKey = e.nodeA < e.nodeB ? e.nodeA + '|' + e.nodeB : e.nodeB + '|' + e.nodeA;
      const lenEps = Math.max(tol, Math.abs(e.length) * 1e-9);
      const group = groups.get(pairKey) || [];
      // The geometric midpoint pins the path itself, independent of
      // traversal direction (a curve's own middle is the same point walked
      // either way) — it is what separates a genuine duplicate from, say,
      // the upper and lower halves of one circle between the same two
      // endpoints (same circle, same |sweep|, same length — different arcs).
      const eMid = dxfPointOnSegment(e.seg, 0.5);
      const match = group.find(g => {
        if (g.seg.kind !== e.seg.kind) return false;
        if (Math.abs(g.length - e.length) > lenEps) return false;
        return distance(dxfPointOnSegment(g.seg, 0.5), eMid) <= tol;
      });
      if (match) {
        remap.set(e.segIndex, { segIndex: match.segIndex, flipped: e.nodeA !== match.nodeA });
        collapsed += 1;
        continue;
      }
      group.push(e);
      groups.set(pairKey, group);
      kept.push(e);
    }
    if (!collapsed) return 0;
    work.edges = kept;
    for (const ref of refs) {
      const m = remap.get(ref.segIndex);
      if (m) {
        ref.segIndex = m.segIndex;
        if (m.flipped) ref.t = 1 - ref.t;
      }
    }
    return collapsed;
  }

  // Every simple (no-repeated-node) path from startNode to endNode, as
  // ordered {edge, forward} steps. Depth/route-count budgeted: real garment
  // pattern graphs are sparse (a traced outline is degree <= 2 almost
  // everywhere; even a genuine branch/junction touches only a handful of
  // edges), so a plain DFS is safe here, but the caps are a defensive circuit
  // breaker against a pathological graph rather than a claim about how large
  // a real one gets. RB-4: returns `truncated: true` whenever either cap
  // actually cut the search short, so a caller can tell "here are the only
  // routes" from "here are the first N of possibly more" — presenting a
  // capped candidate set as though it were the complete choice set is exactly
  // the silent-guess failure mode this story must not ship.
  //
  // ADR 0084: when startNode === endNode the request is "the whole way
  // around" — every simple CYCLE through that node, each as a path of >= 1
  // edge that leaves the node and returns to it (a self-loop edge, e.g. a
  // full circle, is a 1-edge cycle). The trivial 0-edge "already there" path
  // is never a route. Nothing else about the search changes: the node is
  // still marked visited once left, so a cycle cannot pass through it
  // twice, and the caps apply identically.
  function dxfEnumerateSimplePaths(adjacency, startNode, endNode, maxRoutes, maxVisits) {
    const routes = [];
    const visited = new Set();
    const usedEdges = new Set();
    const path = [];
    let visits = 0;
    let truncated = false;
    const loopRequest = startNode === endNode;
    function dfs(node) {
      if (routes.length >= maxRoutes || visits > maxVisits) { truncated = true; return; }
      visits += 1;
      if (node === endNode && (!loopRequest || path.length > 0)) { routes.push(path.slice()); return; }
      visited.add(node);
      const edges = adjacency.get(node) || [];
      for (const edge of edges) {
        if (routes.length >= maxRoutes || visits > maxVisits) { truncated = true; break; }
        // No edge twice in one route. Distinct-node simple paths never reuse
        // an edge anyway; this is what stops a loop request from "closing"
        // by walking straight back along the edge it just left (an
        // out-and-back is not the way around anything).
        if (usedEdges.has(edge.id)) continue;
        const next = edge.nodeA === node ? edge.nodeB : edge.nodeA;
        // Returning to the start node closes a loop request — the one case
        // where stepping onto an already-visited node is the goal.
        if (visited.has(next) && !(loopRequest && next === endNode)) continue;
        path.push({ edge, forward: edge.nodeA === node });
        usedEdges.add(edge.id);
        dfs(next);
        usedEdges.delete(edge.id);
        path.pop();
      }
      visited.delete(node);
    }
    dfs(startNode);
    return { routes, truncated };
  }

  // US-126: one chain edge walked the other way — same geometry, each step's
  // own t0/t1 swapped and the order reversed, exactly the transform
  // dxfReverseRoute applies to a whole route.
  function dxfReverseChainSteps(steps) {
    return steps.slice().reverse().map(s => ({ segIndex: s.segIndex, t0: s.t1, t1: s.t0 }));
  }

  // US-126: contract every run of degree-2 nodes into ONE edge before the
  // route DFS runs.
  //
  // Why this is the fix for "measuring along a line with junk points does not
  // work": a factory pattern edge is almost never one entity. A single
  // straight edge is exported as dozens of short collinear LINE/VERTEX runs,
  // and every one of those intermediate vertices used to be a graph node the
  // DFS had to visit. Measured on the real corpus (demo/DXF file/dxf, 41
  // files), 13% of piece route requests blew straight through the search caps
  // and reported ROUTE_SEARCH_TRUNCATED — a hard "cannot measure" on shapes a
  // TD measures by hand in seconds. The junk vertices are not what makes a
  // route ambiguous, though: a node with exactly two edges has exactly one
  // way through it, so any simple path that enters the chain must traverse
  // all of it. Contracting the chain is therefore EXACT — same endpoints,
  // same total length, same set of distinct routes — and it collapses a real
  // 396-node piece to 38 nodes (2844.dxf), 300 to 35 (3286.dxf), 244 to 29
  // (2827.dxf), which is what turns an impossible search into a complete one.
  //
  // `pinnedNodes` are never contracted through: the two clicked endpoints
  // (which must survive as real nodes — they are what the route runs
  // between). A self-loop edge (nodeA === nodeB, e.g. a whole circle, or a
  // fully contracted closed contour) is never absorbed into a chain: its
  // node-pair carries no traversal direction, and a loop request needs it
  // intact as its own 1-edge cycle.
  //
  // `edges` in: [{ id, nodeA, nodeB, length, steps: [{segIndex,t0,t1}] }],
  // steps ordered nodeA -> nodeB. Out: the same shape, fewer edges.
  function dxfCompressDegreeTwoChains(edges, pinnedNodes, edgeIdRef) {
    const live = new Map();
    const incident = new Map();
    const touch = (node, id) => {
      if (!incident.has(node)) incident.set(node, new Set());
      incident.get(node).add(id);
    };
    for (const e of edges) {
      live.set(e.id, e);
      touch(e.nodeA, e.id);
      touch(e.nodeB, e.id);
    }
    const queue = Array.from(incident.keys());
    let guard = edges.length * 4 + 16;
    while (queue.length && guard > 0) {
      guard -= 1;
      const node = queue.pop();
      if (pinnedNodes.has(node)) continue;
      const ids = incident.get(node);
      if (!ids || ids.size !== 2) continue;
      const [id1, id2] = Array.from(ids);
      const e1 = live.get(id1);
      const e2 = live.get(id2);
      if (!e1 || !e2 || e1 === e2) continue;
      if (e1.nodeA === e1.nodeB || e2.nodeA === e2.nodeB) continue;
      if (!Number.isFinite(e1.length) || !Number.isFinite(e2.length)) continue;
      // Orient so e1's steps END at `node` and e2's steps START there.
      const stepsIn = e1.nodeB === node ? e1.steps : dxfReverseChainSteps(e1.steps);
      const from = e1.nodeB === node ? e1.nodeA : e1.nodeB;
      const stepsOut = e2.nodeA === node ? e2.steps : dxfReverseChainSteps(e2.steps);
      const to = e2.nodeA === node ? e2.nodeB : e2.nodeA;
      const merged = {
        id: edgeIdRef.next, nodeA: from, nodeB: to,
        length: e1.length + e2.length, steps: stepsIn.concat(stepsOut),
      };
      edgeIdRef.next += 1;
      live.delete(id1);
      live.delete(id2);
      live.set(merged.id, merged);
      incident.delete(node);
      for (const pair of [[e1.nodeA, id1], [e1.nodeB, id1], [e2.nodeA, id2], [e2.nodeB, id2]]) {
        const set = incident.get(pair[0]);
        if (set) set.delete(pair[1]);
      }
      touch(from, merged.id);
      touch(to, merged.id);
      queue.push(from, to);
      guard = live.size * 4 + 16;
    }
    return Array.from(live.values());
  }

  // US-126: shortest route between two DISTINCT nodes (Dijkstra over the
  // contracted graph), optionally with some edges and nodes forbidden —
  // the two exclusions are what Yen's algorithm below needs to force a
  // deviation. Returns null for a loop request (start === end, where
  // "shortest" has no meaning), when no route exists, or when the
  // exclusions disconnect the pair.
  //
  // The linear-scan minimum is deliberate: after chain contraction the graph
  // is tens of nodes, not thousands, and a heap would only add a data
  // structure to audit. Ties break on the lower node id so the result is a
  // pure function of the graph, not of Map insertion order (determinism,
  // CLAUDE.md).
  function dxfShortestRouteEdges(adjacency, startNode, endNode, bannedEdgeIds, bannedNodes) {
    if (startNode === endNode) return null;
    if (bannedNodes && bannedNodes.has(startNode)) return null;
    const dist = new Map([[startNode, 0]]);
    const prev = new Map();
    const settled = new Set();
    for (;;) {
      let current = null;
      let best = Infinity;
      for (const [node, d] of dist) {
        if (settled.has(node)) continue;
        if (d < best - 1e-12 || (Math.abs(d - best) <= 1e-12 && current !== null && node < current)) {
          best = Math.min(best, d);
          current = node;
        }
      }
      if (current === null) return null;
      best = dist.get(current);
      if (current === endNode) break;
      settled.add(current);
      for (const edge of adjacency.get(current) || []) {
        if (bannedEdgeIds && bannedEdgeIds.has(edge.id)) continue;
        const next = edge.nodeA === current ? edge.nodeB : edge.nodeA;
        if (next === current || settled.has(next) || !Number.isFinite(edge.length)) continue;
        if (bannedNodes && bannedNodes.has(next)) continue;
        const candidate = best + edge.length;
        const known = dist.get(next);
        if (known === undefined || candidate < known - 1e-12) {
          dist.set(next, candidate);
          prev.set(next, { edge, from: current });
        }
      }
    }
    const steps = [];
    let cursor = endNode;
    while (cursor !== startNode) {
      const step = prev.get(cursor);
      if (!step) return null;
      steps.push({ edge: step.edge, forward: step.edge.nodeA === step.from });
      cursor = step.from;
    }
    return steps.reverse();
  }

  // The node a route sits on after `count` steps (its start node when count
  // is 0) — Yen's needs the node sequence, and a step only carries its edge
  // plus a traversal direction.
  function dxfRouteNodeAfter(startNode, steps, count) {
    let node = startNode;
    for (let i = 0; i < count; i += 1) {
      const step = steps[i];
      node = step.forward ? step.edge.nodeB : step.edge.nodeA;
    }
    return node;
  }

  function dxfRouteEdgeKey(steps) {
    return steps.map(s => s.edge.id).join('>');
  }

  function dxfStepsLength(steps) {
    return steps.reduce((sum, s) => sum + s.edge.length, 0);
  }

  // US-126 (round 2): Yen's k-shortest LOOPLESS paths.
  //
  // Why this replaces "enumerate N by DFS, then sort": a capped DFS reaches
  // routes in arbitrary order, so sorting its sample ranks the SAMPLE, not
  // the graph. Measured against an uncontracted exhaustive reference over the
  // real corpus, that was fine wherever the piece had at most the enumeration
  // cap's worth of routes (195 cases, 0 disagreements) and WRONG wherever it
  // had more (21 of 30 cases): candidates 1..k-1 were arbitrary long detours
  // while the chooser claimed to be showing the k shortest. Only candidate 0
  // was ever truly shortest, because it was seeded by Dijkstra.
  //
  // Yen's makes the claim true by construction. Each new route is the
  // shortest path that deviates from an already-accepted one at some node:
  // the "root" prefix is fixed, every edge that leaves that prefix the same
  // way an accepted route did is forbidden, the prefix's own interior nodes
  // are forbidden (that is what keeps the result loopless), and the rest is a
  // plain shortest path. Affordable only because chain contraction ran first:
  // k * (path length) Dijkstras over a graph of tens of nodes.
  //
  // Returns { routes, more } — `more` is true when at least one further
  // candidate existed but was not promoted, i.e. the offered set really is
  // "the k shortest, and there are others".
  function dxfKShortestRoutes(adjacency, startNode, endNode, k, maxSpurSearches) {
    const first = dxfShortestRouteEdges(adjacency, startNode, endNode);
    if (!first) return { routes: [], more: false };
    const accepted = [first];
    const acceptedKeys = new Set([dxfRouteEdgeKey(first)]);
    const candidates = [];
    const candidateKeys = new Set();
    let spurSearches = 0;
    let budgetHit = false;
    while (accepted.length < k) {
      const previous = accepted[accepted.length - 1];
      for (let i = 0; i < previous.length; i += 1) {
        if (spurSearches >= maxSpurSearches) { budgetHit = true; break; }
        spurSearches += 1;
        const rootSteps = previous.slice(0, i);
        const rootKey = dxfRouteEdgeKey(rootSteps);
        const spurNode = dxfRouteNodeAfter(startNode, previous, i);
        // Forbid the continuation every accepted route with this same root
        // already took — otherwise the "deviation" reproduces a route we hold.
        const bannedEdgeIds = new Set();
        for (const route of accepted) {
          if (route.length > i && dxfRouteEdgeKey(route.slice(0, i)) === rootKey) {
            bannedEdgeIds.add(route[i].edge.id);
          }
        }
        // Forbid the root's own interior nodes (everything strictly before the
        // spur node) so the spur cannot loop back through the prefix.
        const bannedNodes = new Set();
        for (let n = 0; n < i; n += 1) bannedNodes.add(dxfRouteNodeAfter(startNode, previous, n));
        const spur = dxfShortestRouteEdges(adjacency, spurNode, endNode, bannedEdgeIds, bannedNodes);
        if (!spur) continue;
        const whole = rootSteps.concat(spur);
        const key = dxfRouteEdgeKey(whole);
        if (acceptedKeys.has(key) || candidateKeys.has(key)) continue;
        candidateKeys.add(key);
        candidates.push(whole);
      }
      if (!candidates.length) break;
      // Deterministic order: shortest first, ties broken on the edge-id
      // signature so the choice never depends on discovery order.
      candidates.sort((a, b) => (dxfStepsLength(a) - dxfStepsLength(b))
        || (dxfRouteEdgeKey(a) < dxfRouteEdgeKey(b) ? -1 : dxfRouteEdgeKey(a) > dxfRouteEdgeKey(b) ? 1 : 0));
      const next = candidates.shift();
      candidateKeys.delete(dxfRouteEdgeKey(next));
      accepted.push(next);
      acceptedKeys.add(dxfRouteEdgeKey(next));
      if (budgetHit) break;
    }
    return { routes: accepted, more: candidates.length > 0 || budgetHit };
  }

  // How many routes the TD is ever offered. Unchanged: more than a handful of
  // Tab presses is not a choice, it is a maze.
  const DXF_ROUTE_MAX_CANDIDATES = 8;
  // US-126 (round 2): Yen's spur-search budget for the open case. k * the
  // longest accepted route's step count is the natural bound; this is the
  // defensive ceiling above it, so a pathological graph that somehow survived
  // chain contraction with hundreds of junctions cannot spin. Hitting it sets
  // `more`, exactly like a leftover candidate would — the offered set is still
  // the k shortest FOUND, and the TD is still told others exist.
  const DXF_ROUTE_MAX_SPUR_SEARCHES = 4000;
  // Loop requests (A and B on the same point of a closed contour) are cycles,
  // not paths, so Yen's does not apply and the DFS still enumerates them.
  // A real closed contour contracts to one or two edges, so these caps are
  // generous rather than load-bearing.
  const DXF_ROUTE_MAX_ENUMERATED = 64;
  const DXF_ROUTE_MAX_VISITS = 60000;

  // The Along Path oracle: given the full native segment list for a piece (or
  // component) and two point-on-path references ({segIndex, t} into that same
  // list), returns every distinct simple route connecting them. 0 candidates
  // means A and B are not on the same connected path
  // (DXF_MEASURE_REASON.NO_CONNECTED_PATH); 1 means an unambiguous open path
  // (or a degenerate A===B); 2 is the common closed-contour case (the two
  // ways around the loop); >2 means a genuine branch/junction, which the
  // interaction layer must present as explicit candidates rather than
  // silently resolving. `nodeTolerance` (optional, absolute native units) is
  // the unit-aware topology tolerance — see dxfDefaultTopologyTolerance's
  // comment; callers with real unit context (dxf-measure-session.js) always
  // pass one.
  function dxfEnumerateRoutes(segments, refA, refB, nodeTolerance) {
    if (!Array.isArray(segments) || !segments.length) {
      return { ok: false, reason: DXF_MEASURE_REASON.NO_CONNECTED_PATH, routes: [], truncated: false };
    }
    const validRef = (ref) => ref && Number.isInteger(ref.segIndex) && ref.segIndex >= 0
      && ref.segIndex < segments.length && Number.isFinite(ref.t) && ref.t >= -1e-6 && ref.t <= 1 + 1e-6;
    if (!validRef(refA) || !validRef(refB)) {
      return { ok: false, reason: DXF_MEASURE_REASON.NON_FINITE_GEOMETRY, routes: [], truncated: false };
    }
    const graph = dxfBuildPathGraph(segments, nodeTolerance);
    if (!graph) return { ok: false, reason: DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY, routes: [], truncated: false };
    const work = {
      nodes: graph.nodes.slice(),
      edges: graph.edges.map(e => ({ id: e.id, segIndex: e.segIndex, seg: e.seg, t0: 0, t1: 1, nodeA: e.nodeA, nodeB: e.nodeB, length: e.length })),
      nextNodeId: graph.nodes.length,
      nextEdgeId: graph.edges.length,
    };
    // ADR 0073: drop stacked exact-duplicate copies (and remap A/B onto the
    // kept representative) BEFORE inserting the point refs — inserting first
    // would split only the clicked copy, turning its un-split duplicates
    // into node-skipping bypass edges instead of recognizable parallels.
    const workRefA = { segIndex: refA.segIndex, t: clamp(refA.t, 0, 1) };
    const workRefB = { segIndex: refB.segIndex, t: clamp(refB.t, 0, 1) };
    const tolUsed = Number.isFinite(nodeTolerance) && nodeTolerance > 0 ? nodeTolerance : dxfDefaultTopologyTolerance(segments);
    dxfCollapseDuplicateParallelEdges(work, [workRefA, workRefB], tolUsed);
    const nodeA = dxfInsertPointRefIntoGraph(work, workRefA);
    const nodeB = dxfInsertPointRefIntoGraph(work, workRefB);
    if (nodeA == null || nodeB == null) {
      return { ok: false, reason: DXF_MEASURE_REASON.NON_FINITE_GEOMETRY, routes: [], truncated: false };
    }
    // US-126: contract every degree-2 run into one chain edge before the
    // search. Exact (see dxfCompressDegreeTwoChains) — the clicked endpoints
    // are pinned, so they stay real nodes and the routes between them are
    // unchanged; only the count of nodes the DFS has to walk collapses.
    const edgeIdRef = { next: work.nextEdgeId };
    const chainEdges = dxfCompressDegreeTwoChains(
      work.edges.map(e => ({
        id: e.id, nodeA: e.nodeA, nodeB: e.nodeB, length: e.length,
        steps: [{ segIndex: e.segIndex, t0: e.t0, t1: e.t1 }],
      })),
      new Set([nodeA, nodeB]),
      edgeIdRef
    );
    const adjacency = new Map();
    for (const e of chainEdges) {
      if (!adjacency.has(e.nodeA)) adjacency.set(e.nodeA, []);
      if (!adjacency.has(e.nodeB)) adjacency.set(e.nodeB, []);
      adjacency.get(e.nodeA).push(e);
      adjacency.get(e.nodeB).push(e);
    }
    // US-126 (round 2): the open case takes the k SHORTEST routes from Yen's,
    // which is the only way "these are the shortest N" can be a true statement
    // — see dxfKShortestRoutes for the measured reason a capped DFS plus a
    // sort was not. A loop request (A and B on the same point) asks for cycles
    // rather than paths, which Yen's does not model, so it keeps the DFS.
    let rawRoutes;
    let truncated;
    if (nodeA === nodeB) {
      const found = dxfEnumerateSimplePaths(adjacency, nodeA, nodeB, DXF_ROUTE_MAX_ENUMERATED, DXF_ROUTE_MAX_VISITS);
      truncated = found.truncated;
      // ADR 0084: the DFS walks every cycle through the point in BOTH
      // directions (leave via edge e1 and return via e2, and vice versa) —
      // the same edges, the same length, one loop. Keep one per distinct edge
      // set; dxfMeasureBuildDirectionCandidates then presents that one loop as
      // forward/reverse, exactly as it does for a single open route.
      const seenEdgeSets = new Set();
      rawRoutes = found.routes.filter(steps => {
        const key = steps.map(s => s.edge.id).sort((x, y) => x - y).join(',');
        if (seenEdgeSets.has(key)) return false;
        seenEdgeSets.add(key);
        return true;
      });
      // An empty list here means A and B sit on the same point of an OPEN path
      // (no cycle through it) — nothing to measure, and a distinct reason from
      // "not connected", which would be a lie about two points that are
      // trivially connected.
      if (!rawRoutes.length && !truncated) {
        return { ok: false, reason: DXF_MEASURE_REASON.SAME_POINT, routes: [], truncated: false };
      }
    } else {
      const yen = dxfKShortestRoutes(adjacency, nodeA, nodeB, DXF_ROUTE_MAX_CANDIDATES, DXF_ROUTE_MAX_SPUR_SEARCHES);
      rawRoutes = yen.routes;
      truncated = yen.more;
    }
    if (!rawRoutes.length) return { ok: false, reason: DXF_MEASURE_REASON.NO_CONNECTED_PATH, routes: [], truncated: false };
    const routes = rawRoutes.map(steps => ({
      steps: steps.flatMap(s => (s.forward ? s.edge.steps : dxfReverseChainSteps(s.edge.steps))),
      length: steps.reduce((sum, s) => sum + s.edge.length, 0),
    })).filter(route => route.steps.length > 0 && Number.isFinite(route.length) && route.length > 0);
    if (!routes.length) {
      return { ok: false, reason: DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY, routes: [], truncated: false };
    }
    // Yen's already returns the open case in ascending length. The loop case
    // is sorted here for the same reason: the first candidate offered should
    // be the shortest way round. Ties break on the route's own step signature
    // so the order is a pure function of the geometry (determinism, CLAUDE.md)
    // — a plain string comparison, never localeCompare, whose result depends
    // on the runtime's collation data.
    const routeKey = route => route.steps.map(s => s.segIndex + ':' + s.t0 + ':' + s.t1).join(',');
    routes.sort((a, b) => (a.length - b.length)
      || (routeKey(a) < routeKey(b) ? -1 : routeKey(a) > routeKey(b) ? 1 : 0));
    const offered = routes.slice(0, DXF_ROUTE_MAX_CANDIDATES);
    // US-126: a capped search is no longer a REFUSAL. It used to throw away
    // every route it had already proven and report ROUTE_SEARCH_TRUNCATED as
    // a hard failure, which on the real corpus meant 13% of piece route
    // requests could not be measured at all. The honest result is the k
    // shortest routes plus `truncated: true` — "here are the shortest N, there
    // are others" — which the interaction layer says out loud in its chooser
    // toast. The reason code stays in the vocabulary for that message.
    return {
      ok: true,
      reason: null,
      routes: offered,
      truncated: truncated || routes.length > offered.length,
    };
  }

  // Positive means the A->B traversal follows more authored entity length
  // (each segment's t=0 -> t=1 direction); negative means it opposes more.
  // This is deliberately independent of DFS candidate order.
  function dxfRouteAuthoredDirectionScore(route, segments) {
    if (!route || !Array.isArray(route.steps) || !Array.isArray(segments)) return NaN;
    let score = 0;
    for (const step of route.steps) {
      const seg = segments[step.segIndex];
      const length = dxfPartialLength(seg, step.t0, step.t1);
      if (!Number.isFinite(length)) return NaN;
      score += (step.t1 >= step.t0 ? 1 : -1) * length;
    }
    return score;
  }

  // The reverse of one route: same edges, opposite order, each step's t0/t1
  // swapped so traversal runs the other way — same total length. This is the
  // "Reverse" direction for the common case of exactly one route (an open
  // path): the two closed-loop route CANDIDATES from dxfEnumerateRoutes are
  // already a genuinely different edge set each, not reverses of one
  // another, so this helper is not used to derive "the other" closed-loop
  // direction — see the session layer for that distinction.
  function dxfReverseRoute(route) {
    if (!route) return null;
    return {
      steps: route.steps.slice().reverse().map(s => ({ segIndex: s.segIndex, t0: s.t1, t1: s.t0 })),
      length: route.length,
    };
  }

  // Sum of every step's own partial length, using each step's OWN t0/t1
  // (already direction-signed by dxfEnumerateRoutes/dxfReverseRoute) against
  // the same segment list the route's segIndex values address. This is the
  // canonical way to get a route's length from its steps alone — used by
  // both the numeric readout and, indirectly, by every test that must prove
  // "the highlighted route is exactly the route measured" (draw exactly these
  // steps; measure exactly these steps; same source).
  // RB-4: same NaN-not-0 contract as dxfSegmentLength/dxfPartialLength — a
  // missing segment reference (a stale step.segIndex after some upstream
  // corruption) poisons the sum instead of silently under-counting it.
  function dxfRouteLength(route, segments, tolerance) {
    if (!route || !Array.isArray(route.steps) || !route.steps.length || !Array.isArray(segments)) return NaN;
    return route.steps.reduce((sum, step) => {
      const seg = segments[step.segIndex];
      return sum + (seg ? dxfPartialLength(seg, step.t0, step.t1, tolerance) : NaN);
    }, 0);
  }
