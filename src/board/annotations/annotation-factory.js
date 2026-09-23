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

  // US-096 / ADR 0055: POM sequence numbers are a measurement identity, so only
  // a measurement line spends one. A run of stitch marks used to punch holes in
  // the numbering — draw POM 1, three zigzags, and the next real line came out
  // as POM 5.
  //
  // A construction line is still BORN with the current number (every factory
  // above stamps `seq: state.nextSequence`), it just does not advance the
  // counter, so the next measurement line reuses it. The duplicate is
  // unreachable while the line stays construction — nothing that reads seq as a
  // POM identity can see it — and reissuePomSequenceOnReentry resolves it at the
  // one moment it could matter: conversion back to a measurement style.
  function consumePomSequenceFor(ann) {
    if (!isMeasurementAnnotation(ann)) return;
    state.nextSequence += 1;
  }

  // Called when a line re-enters the measurement set (Zigzag -> Plain). It has
  // to satisfy TWO things at once, and the first two attempts each got one of
  // them and broke the other:
  //
  //   (i)  no two measurement lines may share a seq, and
  //   (ii) state.nextSequence must end up strictly greater than this line's,
  //        or the next drawn line is stamped with the same number.
  //
  // Attempt one reissued only on an existing conflict. That leaves (ii) broken
  // in the common case: a construction line is born holding state.nextSequence
  // WITHOUT advancing it (consumePomSequenceFor above), so at conversion time
  // the counter still points at the number the line is carrying, nothing
  // conflicts yet, and the very next drawn line collides. Every consumer does
  // `annByPom.set(getLabelText(ann), ann)`, so one of the two silently vanished
  // from the panel and both workbooks.
  //
  // Attempt two reissued unconditionally. That satisfies both, but destroys
  // POM identity on a round trip — and second code review, 2026-08-23, is where
  // that surfaced. An auto-applied line carries `text: null`, so its POM
  // identity IS its seq. A TD who restyles the POM 8 line to zigzag by mistake
  // and immediately picks Plain again got it renumbered to 19: same red line,
  // same geometry, new number, POM 8's row silently emptied in both workbooks.
  // The round trip is the likeliest way a TD meets this code at all, and the
  // suite could not see it because it only ever drove a line BORN as
  // construction.
  //
  // So: keep the number when it is free — a POM 8 line restyled and restyled
  // back is still POM 8 — and only take a fresh one when it is genuinely taken.
  // Either way, push the counter past it, which is the half attempt one missed.
  //
  // A line the TD labelled by hand is left alone entirely: its identity is
  // `text`, not `seq`, so renumbering would be meaningless churn.
  function reissuePomSequenceOnReentry(ann) {
    if (!ann || hasManualPomLabel(ann)) return false;
    const taken = (state.annotations || []).some(other => other !== ann
      && other.seq === ann.seq
      && isMeasurementAnnotation(other));
    if (taken) {
      ann.seq = state.nextSequence;
      state.nextSequence += 1;
      return true;
    }
    if (state.nextSequence <= ann.seq) state.nextSequence = ann.seq + 1;
    return false;
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
