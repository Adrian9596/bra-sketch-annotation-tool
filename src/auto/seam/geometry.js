// US-109 Auto Seam — editable-curve geometry builders shared by the lanes:
// Catmull-Rom-style knot chains, median-smoothed corridor traces, the
// refinement-based fit and the bilateral neckline merge. Every output is the
// existing annotation curve contract (start/control1/control2/end/points[]).
// Pure. Source part for app.js.

  function autoSeamGeometryFromKnots(knots) {
    const tangents = knots.map((point, index) => {
      if (index === 0) return { x: knots[1].x - point.x, y: knots[1].y - point.y };
      if (index === knots.length - 1) return { x: point.x - knots[index - 1].x, y: point.y - knots[index - 1].y };
      return { x: (knots[index + 1].x - knots[index - 1].x) / 2, y: (knots[index + 1].y - knots[index - 1].y) / 2 };
    });
    const handleIn = index => ({
      x: autoSeamClamp01(knots[index].x - tangents[index].x / 3),
      y: autoSeamClamp01(knots[index].y - tangents[index].y / 3),
    });
    const handleOut = index => ({
      x: autoSeamClamp01(knots[index].x + tangents[index].x / 3),
      y: autoSeamClamp01(knots[index].y + tangents[index].y / 3),
    });
    const last = knots.length - 1;
    return {
      type: 'curved',
      start: knots[0],
      control1: handleOut(0),
      control2: handleIn(last),
      end: knots[last],
      points: knots.slice(1, last).map((point, offset) => {
        const index = offset + 1;
        return { point, handleIn: handleIn(index), handleOut: handleOut(index) };
      }),
    };
  }

  // The seed corridor is only a starting guess (a proportional template for
  // most zones, the garment's own top ink contour for the neckline), not this
  // specific garment's real stitch line — it is deliberately never drawn
  // directly (see autoSeamTechnicalCandidate below). Rebuild a per-station
  // centerline from the same refined samples
  // already computed for evidence, using a local median of the raw offsets
  // (autoSeamMedianOffsets) rather than each station's single strongest edge:
  // on a technical flat that raw per-station edge legitimately alternates
  // between individual zigzag tooth vertices, but the local median across a
  // few neighbouring stations cancels that alternation and recovers the
  // corridor's true centerline, which does track this garment's actual
  // proportions instead of the generic seed template.
  function autoSeamSmoothedStationPoints(seed, refined) {
    const offsets = autoSeamMedianOffsets(refined);
    const count = refined.length;
    return refined.map((sample, index) => {
      const t = index / (count - 1);
      const base = autoSeamQuadraticPoint(seed.points, t);
      const tangent = autoSeamQuadraticTangent(seed.points, t);
      const length = Math.max(0.0001, Math.hypot(tangent.x, tangent.y));
      const normal = { x: -tangent.y / length, y: tangent.x / length };
      return { x: base.x + normal.x * offsets[index], y: base.y + normal.y * offsets[index] };
    });
  }

  // Same shape as auto-seam.js's autoSeamGeometryFromRefinement (product-photo
  // lane), generalized to an arbitrary station count: one cubic for most
  // zones, a four-knot Catmull-Rom-style chain for neckline's extra
  // curvature. `points` here are already-smoothed model-pixel coordinates
  // (autoSeamSmoothedStationPoints), not raw per-station samples.
  function autoSeamGeometryFromTechnicalTrace(model, points, zone) {
    const count = points.length;
    if (zone !== 'neckline') {
      const start = autoSeamNormalizePoint(model, points[0]);
      const middle = autoSeamNormalizePoint(model, points[Math.floor(count / 2)]);
      const end = autoSeamNormalizePoint(model, points[count - 1]);
      return {
        type: 'curved', start, end,
        control1: { x: start.x + (middle.x - start.x) * 2 / 3, y: start.y + (middle.y - start.y) * 2 / 3 },
        control2: { x: end.x + (middle.x - end.x) * 2 / 3, y: end.y + (middle.y - end.y) * 2 / 3 },
        points: [],
      };
    }
    const knotIndexes = [0, Math.round((count - 1) / 3), Math.round((2 * (count - 1)) / 3), count - 1];
    const knots = knotIndexes.map(index => autoSeamRefinedKnot(model, points, index));
    const tangents = knots.map((point, index) => {
      if (index === 0) return { x: 0, y: knots[1].y - point.y };
      if (index === knots.length - 1) return { x: point.x - knots[index - 1].x, y: point.y - knots[index - 1].y };
      return { x: (knots[index + 1].x - knots[index - 1].x) / 2, y: (knots[index + 1].y - knots[index - 1].y) / 2 };
    });
    const handleIn = index => ({
      x: autoSeamClamp01(knots[index].x - tangents[index].x / 3),
      y: autoSeamClamp01(knots[index].y - tangents[index].y / 3),
    });
    const handleOut = index => ({
      x: autoSeamClamp01(knots[index].x + tangents[index].x / 3),
      y: autoSeamClamp01(knots[index].y + tangents[index].y / 3),
    });
    const last = knots.length - 1;
    return {
      type: 'curved',
      start: knots[0],
      control1: handleOut(0),
      control2: handleIn(last),
      end: knots[last],
      points: [1, 2].map(index => ({ point: knots[index], handleIn: handleIn(index), handleOut: handleOut(index) })),
    };
  }

  function autoSeamBilateralGeometry(left, right) {
    const leftGeometry = left.rawGeometry;
    const rightGeometry = right.rawGeometry;
    const leftInterior = (leftGeometry.points || []).map(point => point.point);
    const rightInterior = (rightGeometry.points || []).map(point => point.point).reverse();
    const center = {
      x: (leftGeometry.end.x + rightGeometry.end.x) / 2,
      y: (leftGeometry.end.y + rightGeometry.end.y) / 2,
    };
    return autoSeamGeometryFromKnots([
      leftGeometry.start,
      ...leftInterior,
      center,
      ...rightInterior,
      rightGeometry.start,
    ]);
  }

  function autoSeamGeometryFromRefinement(model, refined, zone) {
    if (zone !== 'neckline') {
      const start = autoSeamNormalizePoint(model, refined[0]);
      const middle = autoSeamNormalizePoint(model, refined[Math.floor(refined.length / 2)]);
      const end = autoSeamNormalizePoint(model, refined[refined.length - 1]);
      return {
        type: 'curved', start, end,
        control1: {
          x: start.x + (middle.x - start.x) * 2 / 3,
          y: start.y + (middle.y - start.y) * 2 / 3,
        },
        control2: {
          x: end.x + (middle.x - end.x) * 2 / 3,
          y: end.y + (middle.y - end.y) * 2 / 3,
        },
        points: [],
      };
    }

    // Sample four robust knots from all 49 refined stations, then convert a
    // Catmull–Rom chain into three editable cubic Bézier segments. This keeps
    // the draft smooth while allowing real intermediate curvature instead of
    // forcing every neckline into one almost-straight cubic.
    const knots = [0, 16, 32, 48].map(index => autoSeamRefinedKnot(model, refined, index));
    const tangents = knots.map((point, index) => {
      if (index === 0) return { x: 0, y: knots[1].y - point.y };
      if (index === knots.length - 1) return { x: point.x - knots[index - 1].x, y: point.y - knots[index - 1].y };
      return { x: (knots[index + 1].x - knots[index - 1].x) / 2, y: (knots[index + 1].y - knots[index - 1].y) / 2 };
    });
    const handleIn = index => ({
      x: autoSeamClamp01(knots[index].x - tangents[index].x / 3),
      y: autoSeamClamp01(knots[index].y - tangents[index].y / 3),
    });
    const handleOut = index => ({
      x: autoSeamClamp01(knots[index].x + tangents[index].x / 3),
      y: autoSeamClamp01(knots[index].y + tangents[index].y / 3),
    });
    return {
      type: 'curved',
      start: knots[0],
      control1: handleOut(0),
      control2: handleIn(3),
      end: knots[3],
      points: [1, 2].map(index => ({ point: knots[index], handleIn: handleIn(index), handleOut: handleOut(index) })),
    };
  }
