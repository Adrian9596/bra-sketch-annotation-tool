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
    // Anchor the label to the middle of the curve. For a two-segment curve
    // that's the middle anchor (tangent = direction between its two handles);
    // otherwise fall back to the single cubic's t=0.5 point.
    let point, tangent;
    if (annLike.midPoint && annLike.midHandleIn && annLike.midHandleOut) {
      point = annLike.midPoint;
      tangent = {
        x: annLike.midHandleOut.x - annLike.midHandleIn.x,
        y: annLike.midHandleOut.y - annLike.midHandleIn.y,
      };
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
