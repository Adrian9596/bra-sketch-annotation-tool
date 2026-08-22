// Annotation factory: pure builders for constructing a new annotation record
// and its default label position. createStraightAnnotation and
// computeDefaultLabelPosition are the canonical builders used by the drawing
// flow and the clipboard (src/manual/annotation-clipboard.js).
// Label-collision nudging lives in src/manual/label-layout.js; delete/clear
// lifecycle lives in src/manual/annotation-lifecycle.js; copy/paste/reflect
// lives in src/manual/annotation-clipboard.js.
// Source part for app.js. Run `npm run build` after editing.

  function createStraightAnnotation(start, end, style, color = 'red', arrowType = 'double', lineWidth = DEFAULT_LINE_WIDTH) {
    const id = state.idCounter++;
    const label = computeDefaultLabelPosition({
      type: 'straight',
      start,
      end,
    });
    return {
      id,
      seq: state.nextSequence,
      type: 'straight',
      style,
      color,
      arrowType,
      lineWidth: normalizeLineWidth(lineWidth),
      start: clonePoint(start),
      end: clonePoint(end),
      control1: null,
      control2: null,
      label,
      labelManual: false,
      text: null,
      value: null,
    };
  }

  function computeDefaultLabelPosition(annLike) {
    if (annLike.type === 'straight') {
      const mid = midpoint(annLike.start, annLike.end);
      const angle = Math.atan2(annLike.end.y - annLike.start.y, annLike.end.x - annLike.start.x);
      const offset = 18 / state.zoom;
      return {
        x: mid.x + Math.cos(angle - Math.PI / 2) * offset,
        y: mid.y + Math.sin(angle - Math.PI / 2) * offset
      };
    }
    // Anchor the label to the middle of the curve. For the legacy two-segment
    // shape that's the middle anchor (tangent = direction between its two
    // handles); for a curve with US-093 interior anchors, "middle" means the
    // half-arc-length point of the whole multi-segment path; otherwise (the
    // common case) fall back to the single cubic's exact t=0.5 point —
    // unchanged from before interior anchors existed.
    let point, tangent;
    const points = Array.isArray(annLike.points) ? annLike.points : null;
    if (annLike.midPoint && annLike.midHandleIn && annLike.midHandleOut) {
      point = annLike.midPoint;
      tangent = {
        x: annLike.midHandleOut.x - annLike.midHandleIn.x,
        y: annLike.midHandleOut.y - annLike.midHandleIn.y,
      };
    } else if (points && points.length) {
      // US-093 / ADR 0053 code review, 2026-08-21: walk half the arc length
      // instead of indexing points[]. Picking the middle ENTRY of ann.points
      // teleported the callout: add one interior anchor 20% along POM 18's
      // armhole curve and floor((1 - 1) / 2) = 0 moved the number from the
      // curve's middle onto that 20% anchor, permanently — handleAddPointClick
      // writes it into ann.label, so it then shipped in Copy Image, Export PDF
      // and the Excel embedded PNG. It was also non-monotonic in anchor count
      // (1 and 2 anchors both resolved to points[0], 3 and 4 to points[1]), so
      // adding a third anchor jumped the number a second time. Sampling at
      // BEZIER_SAMPLES * 2 matches how the POM's own length is measured
      // (annotation-lookup.js), so the label sits mid-curve by the same metric
      // the TD reads off the spec panel.
      const polyline = getAnnotationPolyline(annLike, BEZIER_SAMPLES * 2);
      const sample = samplePolylineAt(polyline, polylineLength(polyline) / 2);
      point = sample.point;
      tangent = sample.tangent;
    } else {
      point = bezierPoint(annLike.start, annLike.control1, annLike.control2, annLike.end, 0.5);
      tangent = bezierTangent(annLike.start, annLike.control1, annLike.control2, annLike.end, 0.5);
    }
    const angle = Math.atan2(tangent.y, tangent.x);
    const offset = 20 / state.zoom;
    return {
      x: point.x + Math.cos(angle - Math.PI / 2) * offset,
      y: point.y + Math.sin(angle - Math.PI / 2) * offset
    };
  }
