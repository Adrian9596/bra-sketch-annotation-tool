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
    const allPoints = segments.flatMap(dxfSegmentGraphEndpoints);
    const bbox = dxfBoundsOfPoints(allPoints);
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
  function dxfEnumerateSimplePaths(adjacency, startNode, endNode, maxRoutes, maxVisits) {
    const routes = [];
    const visited = new Set();
    const path = [];
    let visits = 0;
    let truncated = false;
    function dfs(node) {
      if (routes.length >= maxRoutes || visits > maxVisits) { truncated = true; return; }
      visits += 1;
      if (node === endNode) { routes.push(path.slice()); return; }
      visited.add(node);
      const edges = adjacency.get(node) || [];
      for (const edge of edges) {
        if (routes.length >= maxRoutes || visits > maxVisits) { truncated = true; break; }
        const next = edge.nodeA === node ? edge.nodeB : edge.nodeA;
        if (visited.has(next)) continue;
        path.push({ edge, forward: edge.nodeA === node });
        dfs(next);
        path.pop();
      }
      visited.delete(node);
    }
    dfs(startNode);
    return { routes, truncated };
  }

  const DXF_ROUTE_MAX_CANDIDATES = 8;
  const DXF_ROUTE_MAX_VISITS = 20000;

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
    const nodeA = dxfInsertPointRefIntoGraph(work, { segIndex: refA.segIndex, t: clamp(refA.t, 0, 1) });
    const nodeB = dxfInsertPointRefIntoGraph(work, { segIndex: refB.segIndex, t: clamp(refB.t, 0, 1) });
    if (nodeA == null || nodeB == null) {
      return { ok: false, reason: DXF_MEASURE_REASON.NON_FINITE_GEOMETRY, routes: [], truncated: false };
    }
    const adjacency = new Map();
    for (const e of work.edges) {
      if (!adjacency.has(e.nodeA)) adjacency.set(e.nodeA, []);
      if (!adjacency.has(e.nodeB)) adjacency.set(e.nodeB, []);
      adjacency.get(e.nodeA).push(e);
      adjacency.get(e.nodeB).push(e);
    }
    const { routes: rawRoutes, truncated } = dxfEnumerateSimplePaths(adjacency, nodeA, nodeB, DXF_ROUTE_MAX_CANDIDATES, DXF_ROUTE_MAX_VISITS);
    if (!rawRoutes.length) return { ok: false, reason: DXF_MEASURE_REASON.NO_CONNECTED_PATH, routes: [], truncated: false };
    const routes = rawRoutes.map(steps => ({
      steps: steps.map(s => ({
        segIndex: s.edge.segIndex,
        t0: s.forward ? s.edge.t0 : s.edge.t1,
        t1: s.forward ? s.edge.t1 : s.edge.t0,
      })),
      length: steps.reduce((sum, s) => sum + s.edge.length, 0),
    })).filter(route => route.steps.length > 0 && Number.isFinite(route.length) && route.length > 0);
    if (!routes.length) {
      return { ok: false, reason: DXF_MEASURE_REASON.UNSUPPORTED_GEOMETRY, routes: [], truncated: false };
    }
    if (truncated) {
      return { ok: false, reason: DXF_MEASURE_REASON.ROUTE_SEARCH_TRUNCATED, routes: [], truncated: true };
    }
    return { ok: true, reason: null, routes, truncated: false };
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
