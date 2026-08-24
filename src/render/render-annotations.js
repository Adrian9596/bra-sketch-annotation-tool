// Annotation drawing primitives: line core + path, arrowheads, label,
// selection helpers, and handles. Source part for app.js.
// Run `npm run build` after editing.
//
// drawAnnotation is the top-level entry; it dispatches between
// drawLineCore (committed/draft line body and stitches) and the helpers
// here (handles, label, etc.). drawLabel and drawSelectionHelpers carry
// state-aware tweaks (e.g. selection highlight, alpha) so the same
// helpers serve hover, selected, and draft renderings.

  // Feature sizes (stroke width, arrowheads, callout font) are divided by
  // state.zoom so they hold a CONSTANT on-screen pixel size at any zoom. During
  // export, though, "zoom" is the render density: copy-image and export-pdf set
  // state.zoom to the native-resolution scale, which US-056 pushed well above the
  // old flat 2x. Dividing features by that big scale pins them to a few absolute
  // device pixels — hairline lines and microscopic callout numbers on a ~2000px+
  // board (visible the moment Excel shrinks the pasted PNG). featureZoom() lets an
  // export path override the divisor with a fixed reference (state.exportFeatureZoom)
  // so features stay a constant FRACTION of the board while the image still renders
  // at native resolution. Screen rendering never sets the override, so it is a
  // no-op there (returns state.zoom unchanged).
  function featureZoom() {
    return state.exportFeatureZoom || state.zoom;
  }

  function drawAnnotation(ann, withLabel = true) {
    drawLineCore(ann, 1);
    if (withLabel) drawAnnotationLabel(ann);
  }

  // The callout number is drawn in a SEPARATE pass (after every line body and
  // the anchor layer — see render()) so a later line or anchor never paints
  // over a POM number. Keeps each number readable on a crowded 3-view board.
  function drawAnnotationLabel(ann) {
    if (state.editingLabelId === ann.id) return;
    // US-096: labelsVisible() is the board-wide gate (Stitch mode, Hide
    // Numbers); annotationShowsCallout adds the per-line one, so a stitch mark
    // stays unnumbered even on a board that is numbering every real POM.
    if (!annotationShowsCallout(ann)) return;
    drawLabel(ann.label, getLabelText(ann), state.selection.kind === 'annotation' && ann.id === state.selection.id, 1, getAnnotationColor(ann));
  }

  function drawLineCore(ann, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const color = getAnnotationColor(ann);
    ctx.strokeStyle = color;
    const lineWidth = getLineWidth(ann);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let style = getLineStyle(ann);
    if (style === 'solid' && annotationCrossesViews(ann)) style = 'dashed';

    const treated = hasLineTreatment(ann) && drawLineTreatment(ann, ann.lineTreatment);
    if (treated) {
      // The Treatment recipe owns every visible layer. The annotation path
      // remains the editable/hit-test spine and is deliberately not painted a
      // second time underneath it.
    } else if (style === 'zigzag') {
      drawZigzagStitchLine(ann, color, lineWidth);
    } else if (style === 'cover') {
      drawCoverStitchLine(ann, color, lineWidth);
    } else if (style === 'bartack') {
      drawBartackStitchLine(ann, color, lineWidth);
    } else {
      ctx.lineWidth = lineWidth / featureZoom();
      ctx.setLineDash(style === 'dashed' ? [10 / featureZoom(), 7 / featureZoom()] : []);
      drawAnnotationPath(ann);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    if (treated) {
      // Treatments are construction depiction, never POM arrow geometry.
    } else if (ann.type === 'straight') {
      drawArrowheadsForStraight(ann, color, lineWidth);
    } else {
      drawArrowheadsForCurve(ann, color, lineWidth);
    }
    ctx.restore();
  }

  function drawAnnotationPath(ann) {
    ctx.beginPath();
    ctx.moveTo(ann.start.x, ann.start.y);
    if (ann.type === 'straight') {
      ctx.lineTo(ann.end.x, ann.end.y);
    } else {
      for (const s of getCurveBeziers(ann)) {
        ctx.bezierCurveTo(s.p1.x, s.p1.y, s.p2.x, s.p2.y, s.p3.x, s.p3.y);
      }
    }
  }

  function drawArrowheadsForStraight(ann, color, lineWidth) {
    const arrowType = getArrowType(ann);
    if (arrowType === 'none') return;
    const arrowSize = (10 + lineWidth * 0.55) / featureZoom();
    drawArrowhead(ann.end, Math.atan2(ann.end.y - ann.start.y, ann.end.x - ann.start.x), arrowSize, color);
    if (arrowType === 'double') {
      drawArrowhead(ann.start, Math.atan2(ann.start.y - ann.end.y, ann.start.x - ann.end.x), arrowSize, color);
    }
  }

  function drawArrowheadsForCurve(ann, color, lineWidth) {
    const arrowType = getArrowType(ann);
    if (arrowType === 'none') return;
    const arrowSize = (10 + lineWidth * 0.55) / featureZoom();
    const endAngle = Math.atan2(ann.end.y - ann.control2.y, ann.end.x - ann.control2.x);
    drawArrowhead(ann.end, endAngle, arrowSize, color);
    if (arrowType === 'double') {
      const startAngle = Math.atan2(ann.start.y - ann.control1.y, ann.start.x - ann.control1.x);
      drawArrowhead(ann.start, startAngle, arrowSize, color);
    }
  }

  function drawArrowhead(point, angle, size, color = LINE_COLOR) {
    const spread = Math.PI / 7;
    const wing = size * 0.9;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(
      point.x - Math.cos(angle - spread) * wing,
      point.y - Math.sin(angle - spread) * wing
    );
    ctx.lineTo(
      point.x - Math.cos(angle + spread) * wing,
      point.y - Math.sin(angle + spread) * wing
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawLabel(pos, text, selected, alpha = 1, color = LINE_COLOR) {
    const fontSize = 17 / featureZoom();
    const halo = 3 / featureZoom();
    // White label fill is invisible on the white canvas — use a dark halo so
    // the callout number still reads when the line color is white.
    const isWhiteFill = String(color || '').toLowerCase() === '#ffffff';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '700 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = isWhiteFill ? halo * 1.4 : halo;
    ctx.shadowColor = 'rgba(17,24,39,.18)';
    ctx.shadowBlur = 4 / featureZoom();
    ctx.shadowOffsetY = 1 / featureZoom();
    ctx.strokeStyle = isWhiteFill ? '#111827' : '#ffffff';
    ctx.strokeText(String(text), pos.x, pos.y);
    ctx.fillStyle = color;
    ctx.fillText(String(text), pos.x, pos.y);
    ctx.restore();
  }

  function drawSelectionHelpers(ann) {
    // US-027: the part the arrow keys currently move (Tab / handle drag sets
    // it) renders filled so the TD can see what a keypress will nudge.
    const activePart = state.selection.kind === 'annotation' && state.selection.id === ann.id
      ? state.selection.part || null : null;
    ctx.save();

    if (ann.type === 'curved') {
      // Single cubic: two control handles, each with a dashed guide line from
      // its endpoint (control1 off start, control2 off end) — the pen-tool
      // model. Drag an endpoint to move it (its handle follows), drag a handle
      // to bend that end.
      ctx.setLineDash([6 / state.zoom, 5 / state.zoom]);
      ctx.strokeStyle = 'rgba(53,109,255,.45)';
      ctx.lineWidth = 1.2 / state.zoom;
      ctx.beginPath();
      if (ann.control1) { ctx.moveTo(ann.start.x, ann.start.y); ctx.lineTo(ann.control1.x, ann.control1.y); }
      if (ann.control2) { ctx.moveTo(ann.end.x, ann.end.y); ctx.lineTo(ann.control2.x, ann.control2.y); }
      ctx.stroke();
      ctx.setLineDash([]);
      if (ann.control1) drawHandle(ann.control1, false, activePart === 'control1');
      if (ann.control2) drawHandle(ann.control2, false, activePart === 'control2');

      // US-093: every interior anchor the TD added, drawn the same way — a
      // dashed guide from the anchor to each of its two handles, all of it
      // always visible while the curve is selected (no crowding gate, ADR
      // 0053). The anchor point itself renders like start/end (emphasized);
      // its handles render like control1/control2 (small).
      //
      // US-093 / ADR 0053 code review, 2026-08-21: the guide strokeStyle and
      // lineWidth set for control1/control2 above are still in effect here, so
      // this loop does NOT re-assign them — drawHandle wraps itself in
      // save/restore and cannot clobber them, which made those two writes pure
      // waste once per anchor on every repaint of a selected curve (i.e. on
      // every mousemove of a drag). The setLineDash pair below is a different
      // story and must stay INSIDE the loop: drawHandle never touches the dash,
      // so it inherits whatever is armed at the call site, and the handle rings
      // have to come out solid. Hoisting the dash out would draw every guide
      // after the first one solid and every handle ring after the first one
      // dashed.
      const points = ann.points || [];
      for (let i = 0; i < points.length; i += 1) {
        const pt = points[i];
        if (!pt.point) continue;
        ctx.setLineDash([6 / state.zoom, 5 / state.zoom]);
        ctx.beginPath();
        if (pt.handleIn) { ctx.moveTo(pt.point.x, pt.point.y); ctx.lineTo(pt.handleIn.x, pt.handleIn.y); }
        if (pt.handleOut) { ctx.moveTo(pt.point.x, pt.point.y); ctx.lineTo(pt.handleOut.x, pt.handleOut.y); }
        ctx.stroke();
        ctx.setLineDash([]);
        if (pt.handleIn) drawHandle(pt.handleIn, false, activePart === 'point' + i + '.handleIn');
        if (pt.handleOut) drawHandle(pt.handleOut, false, activePart === 'point' + i + '.handleOut');
        drawHandle(pt.point, true, activePart === 'point' + i + '.point');
      }
    }

    drawHandle(ann.start, true, activePart === 'start');
    drawHandle(ann.end, true, activePart === 'end');
    drawLabelHandle(ann.label, getAnnotationColor(ann));
    ctx.restore();
    drawAdjustmentReadout(ann);
  }

  // Lighter per-line marker for a MULTI-selection (Shift+click / marquee): just
  // the endpoint dots, no control/label handles or readout — enough to show the
  // line is in the group without the busy single-line editing apparatus.
  function drawAnnotationSelectedOutline(ann) {
    if (!ann || !ann.start || !ann.end) return;
    ctx.save();
    drawHandle(ann.start, true, false);
    drawHandle(ann.end, true, false);
    ctx.restore();
  }

  // Rubber-band selection rectangle, in world coordinates.
  function drawMarquee(m) {
    if (!m || !m.startWorld || !m.currentWorld) return;
    const x = Math.min(m.startWorld.x, m.currentWorld.x);
    const y = Math.min(m.startWorld.y, m.currentWorld.y);
    const w = Math.abs(m.currentWorld.x - m.startWorld.x);
    const h = Math.abs(m.currentWorld.y - m.startWorld.y);
    ctx.save();
    ctx.fillStyle = 'rgba(53,109,255,0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(53,109,255,0.75)';
    ctx.lineWidth = 1 / state.zoom;
    ctx.setLineDash([5 / state.zoom, 4 / state.zoom]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // US-029: floating measurement readout, shown only WHILE the line is being
  // adjusted (endpoint/handle mouse-drag or an open key-nudge burst) so the
  // TD can steer toward a target value without looking away to the panel.
  // Same value text and Δ ✓/✗ verdict as the panel's Value cell
  // (measuredValueText / specDeltaText), pinned near the moving point.
  function drawAdjustmentReadout(ann) {
    const interaction = state.interaction;
    const dragging = !!(interaction && interaction.type === 'drag-handle' && interaction.id === ann.id);
    const nudging = isLineNudgeActive(ann.id);
    if (!dragging && !nudging) return;
    const text = measuredValueText(ann);
    if (!text) return;
    const ev = evaluateSpecTolerance(ann, getLabelText(ann));
    const deltaText = specDeltaText(ev);

    const part = dragging ? interaction.part : state.selection.part;
    const point = (part && getAnnPartPoint(ann, part))
      || { x: (ann.start.x + ann.end.x) / 2, y: (ann.start.y + ann.end.y) / 2 };

    const z = state.zoom;
    const fontSize = 13 / z;
    const padX = 7 / z;
    const gap = 6 / z;
    const pillH = 22 / z;
    ctx.save();
    ctx.font = '600 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
    const valueW = ctx.measureText(text).width;
    const deltaW = deltaText ? ctx.measureText(deltaText).width + gap : 0;
    const pillW = valueW + deltaW + padX * 2;
    // Above-right of the moving point; the cursor/point stays unobscured.
    const x = point.x + 14 / z;
    const y = point.y - 16 / z - pillH;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, pillW, pillH, 5 / z);
    } else {
      ctx.rect(x, y, pillW, pillH);
    }
    ctx.fillStyle = 'rgba(17,24,39,.88)';
    ctx.shadowColor = 'rgba(17,24,39,.25)';
    ctx.shadowBlur = 5 / z;
    ctx.shadowOffsetY = 1 / z;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + padX, y + pillH / 2);
    if (deltaText) {
      ctx.fillStyle = ev.status === 'in' ? '#4ade80' : ev.status === 'out' ? '#f87171' : '#d1d5db';
      ctx.fillText(deltaText, x + padX + valueW + gap, y + pillH / 2);
    }
    ctx.restore();
  }

  function drawHandle(point, emphasized, active = false) {
    const r = ((emphasized ? 7.5 : 6.0) + (active ? 1.5 : 0)) / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    // Active = the point the arrow keys move: filled blue with a white ring,
    // the inverse of the normal hollow handle, so it reads at a glance.
    ctx.fillStyle = active ? SELECT_COLOR : '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = active ? '#ffffff' : (emphasized ? SELECT_COLOR : 'rgba(53,109,255,.72)');
    ctx.stroke();
    if (active) {
      // US-034: detached outer ring makes the active handle a bullseye —
      // a shape cue that survives grayscale and any color-vision deficiency,
      // instead of relying on the blue fill alone.
      ctx.beginPath();
      ctx.arc(point.x, point.y, r + 4 / state.zoom, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 / state.zoom;
      ctx.strokeStyle = SELECT_COLOR;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawLabelHandle(point, color = LINE_COLOR) {
    const r = 7 / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }
