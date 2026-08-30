// US-105: DXF Pattern Measurement — the overlay renderer. Drawn as its own
// layer, last (topmost), inside the same world-space ctx.save()/translate/
// scale block every other board layer uses (see render-loop.js), so
// measurements share pan/zoom automatically and are never obscured by
// annotations/labels/handles.
// Source part for app.js. Run `npm run build` after editing.

  const DXF_MEASURE_COLOR = '#ff8a00'; // distinct from red/blue POM lines and black DXF geometry
  const DXF_MEASURE_INVALID_COLOR = '#ef4444';
  const DXF_MEASURE_CANDIDATE_COLORS = ['#22c55e', '#3b82f6', '#a855f7', '#f59e0b', '#14b8a6', '#ec4899', '#84cc16', '#0ea5e9'];

  function drawDxfMeasurements() {
    const session = state.dxfMeasureSession;
    if (!session) return;
    // RB-3: the ONE place per frame a live endpoint-drag preview gets
    // (re)computed — see dxfMeasureRecomputeDragPreview's own comment for why
    // this collapses however many raw mousemove events arrived since the
    // last frame into a single projection + route enumeration.
    if (session.interaction && session.interaction.type === 'drag-endpoint') {
      dxfMeasureRecomputeDragPreview(session, session.interaction);
    }
    const activeId = session.selectedMeasurementId;
    for (const measurement of session.measurements) {
      drawOneDxfMeasurement(session, measurement, measurement.id === activeId);
    }
    if (session.interaction) drawDxfMeasureInteractionPreview(session, session.interaction);
  }

  function drawDxfMeasureRoutePolyline(pts, color, weight, alpha, dashed) {
    if (pts.length < 2) return;
    const z = Math.max(0.0001, state.zoom);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = weight / z;
    ctx.setLineDash(dashed ? [6 / z, 4 / z] : []);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  function drawDxfMeasureHandle(point) {
    const z = Math.max(0.0001, state.zoom);
    const r = 6 / z;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 / z;
    ctx.strokeStyle = DXF_MEASURE_COLOR;
    ctx.stroke();
    ctx.restore();
  }

  function drawDxfMeasureHandleLabeled(point, text) {
    drawDxfMeasureHandle(point);
    const z = Math.max(0.0001, state.zoom);
    ctx.save();
    ctx.font = '700 ' + (11 / z).toFixed(1) + 'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 / z;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(text, point.x, point.y - 14 / z);
    ctx.fillStyle = DXF_MEASURE_COLOR;
    ctx.fillText(text, point.x, point.y - 14 / z);
    ctx.restore();
  }

  // RB-1: `pts` is always in canonical A(first)-to-B(last) order — `reverse`
  // is the only thing that decides which end gets the arrowhead (arrow at B
  // for 'forward', at A for 'reverse'), so the arrow can flip without ever
  // reordering the underlying route-point array A/B labels are drawn from.
  function drawDxfMeasureDirectionArrow(pts, color, reverse) {
    if (pts.length < 2) return;
    const b = reverse ? pts[0] : pts[pts.length - 1];
    const a = reverse ? pts[1] : pts[pts.length - 2];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const z = Math.max(0.0001, state.zoom);
    drawArrowhead(b, angle, 12 / z, color || DXF_MEASURE_COLOR);
  }

  // Compact value pill — up to three decimals, trailing zeroes trimmed, inch
  // suffix (dxfMeasureFormatInches). A manually-dragged label gets a dashed
  // leader back to its route anchor so it stays visibly associated with the
  // route it describes even parked well away from it.
  function drawDxfMeasureLabel(session, measurement, active) {
    const pos = dxfMeasureLabelWorldPos(session, measurement);
    if (!pos) return;
    const valueIn = dxfMeasureDisplayValueInches(session, measurement);
    const text = dxfMeasureFormatInches(valueIn) || '—';
    const z = Math.max(0.0001, state.zoom);
    const fontSize = 12 / z, padX = 6 / z, padY = 4 / z;
    ctx.save();
    ctx.font = (active ? '700 ' : '600 ') + fontSize.toFixed(1) + 'px system-ui, -apple-system, sans-serif';
    const textWidth = ctx.measureText(text).width;
    const boxW = textWidth + padX * 2, boxH = fontSize + padY * 2;
    if (measurement.labelOffset) {
      const anchor = dxfMeasureLabelAnchorWorldPos(session, measurement);
      if (anchor) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,138,0,0.55)';
        ctx.lineWidth = 1 / z;
        ctx.setLineDash([3 / z, 3 / z]);
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.beginPath();
    const r = 4 / z;
    if (typeof ctx.roundRect === 'function') ctx.roundRect(pos.x - boxW / 2, pos.y - boxH / 2, boxW, boxH, r);
    else ctx.rect(pos.x - boxW / 2, pos.y - boxH / 2, boxW, boxH);
    ctx.fillStyle = active ? 'rgba(230,110,0,0.95)' : 'rgba(17,24,39,0.82)';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1 / z;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pos.x, pos.y);
    ctx.restore();
  }

  function drawOneDxfMeasurement(session, measurement, active) {
    const pts = dxfMeasureRouteWorldPoints(session, measurement, 16);
    if (pts.length < 2) { drawDxfMeasureLabel(session, measurement, active); return; }
    const invalid = dxfMeasureDragInvalidFor(session, measurement.id);
    const color = invalid ? DXF_MEASURE_INVALID_COLOR : DXF_MEASURE_COLOR;
    drawDxfMeasureRoutePolyline(pts, color, active ? 4.5 : 2, active ? 0.95 : 0.55, false);
    if (active) {
      // RB-1: A/B are drawn from the measurement's own IDENTITY
      // (dxfMeasureHandleWorldPos reads measurement.a/measurement.b, live-
      // aware of an in-progress drag preview), never from pts[0]/pts[last] —
      // so their pixel position cannot depend on which way `route.steps`
      // happens to be ordered, and never swaps when direction changes.
      const aPos = dxfMeasureHandleWorldPos(session, measurement, 'a');
      const bPos = dxfMeasureHandleWorldPos(session, measurement, 'b');
      if (aPos) drawDxfMeasureHandleLabeled(aPos, 'A');
      if (bPos) drawDxfMeasureHandleLabeled(bPos, 'B');
      drawDxfMeasureDirectionArrow(pts, color, measurement.direction === 'reverse');
    }
    drawDxfMeasureLabel(session, measurement, active);
  }

  // ---- Choosing-route preview (RB-1: unified route/direction candidates) ----

  function dxfMeasureCandidateRoutePoints(session, pieceIndex, route) {
    const piece = session.pieces[pieceIndex];
    if (!piece || !route) return [];
    const points = [];
    for (const step of route.steps) {
      const seg = piece.segments[step.segIndex];
      if (!seg) continue;
      for (let i = 0; i <= 10; i += 1) {
        const t = step.t0 + (step.t1 - step.t0) * (i / 10);
        const p = dxfMeasureNativeToBoardLive(dxfPointOnSegment(seg, t), session, pieceIndex);
        if (p) points.push(p);
      }
    }
    return points;
  }

  // Draws every candidate the TD is currently choosing between (Tab
  // cycles, Enter confirms `chosenIndex`) — each in its own color so an
  // overlapping/near-duplicate set (RB-2/RB-4's "genuine duplicate LINE
  // entities" case) stays visually distinguishable, chosen one heaviest.
  // For a single-route open path, `candidates` holds two VIRTUAL entries
  // (same points, opposite arrow) rather than a second UI construct — see
  // dxfMeasureBuildDirectionCandidates.
  function drawDxfMeasureRouteCandidates(session, interaction) {
    const pieceIndex = interaction.a.pieceIndex;
    interaction.candidates.forEach((candidate, idx) => {
      const chosen = idx === interaction.chosenIndex;
      const route = interaction.routes[candidate.routeIndex];
      const points = dxfMeasureCandidateRoutePoints(session, pieceIndex, route);
      const color = DXF_MEASURE_CANDIDATE_COLORS[candidate.routeIndex % DXF_MEASURE_CANDIDATE_COLORS.length];
      drawDxfMeasureRoutePolyline(points, color, chosen ? 5 : 2.5, chosen ? 0.95 : 0.4, !chosen);
      if (chosen && points.length >= 2) drawDxfMeasureDirectionArrow(points, color, candidate.direction === 'reverse');
    });
  }

  // ---- Choosing-entity preview (RB-2) -----------------------------------------

  // Highlights every candidate native entity within tolerance at an
  // ambiguous click — the currently Tab-cycled one drawn larger/opaque, the
  // rest small and dim, so "which entity is this choice about" never has to
  // be guessed from a toast alone.
  function drawDxfMeasureEntityCandidates(session, interaction) {
    const z = Math.max(0.0001, state.zoom);
    interaction.hits.forEach((hit, idx) => {
      const chosen = idx === interaction.chosenIndex;
      const piece = session.pieces[hit.pieceIndex];
      const seg = piece && piece.segments[hit.segIndexInPiece];
      if (!seg) return;
      const native = dxfPointOnSegment(seg, hit.t);
      const board = dxfMeasureNativeToBoardLive(native, session, hit.pieceIndex);
      if (!board) return;
      const color = DXF_MEASURE_CANDIDATE_COLORS[idx % DXF_MEASURE_CANDIDATE_COLORS.length];
      ctx.save();
      ctx.globalAlpha = chosen ? 0.95 : 0.5;
      ctx.beginPath();
      ctx.arc(board.x, board.y, (chosen ? 9 : 5) / z, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = (chosen ? 2.5 : 1.5) / z;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawDxfMeasureInteractionPreview(session, interaction) {
    if (interaction.type === 'awaiting-b') {
      const nativeA = interaction.mode === 'out-of-path'
        ? interaction.a.native
        : dxfMeasureNativePointForRef(session, interaction.a);
      const boardA = interaction.mode === 'out-of-path'
        ? (interaction.a.pieceIndex == null
          ? dxfMeasureNativeToBoard(nativeA, session)
          : dxfMeasureNativeToBoardLive(nativeA, session, interaction.a.pieceIndex))
        : dxfMeasureNativeToBoardLive(nativeA, session, interaction.a.pieceIndex);
      if (boardA) drawDxfMeasureHandleLabeled(boardA, 'A');
      return;
    }
    if (interaction.type === 'choosing-route') {
      drawDxfMeasureRouteCandidates(session, interaction);
      const nativeA = dxfMeasureNativePointForRef(session, interaction.a);
      const nativeB = dxfMeasureNativePointForRef(session, interaction.b);
      const boardA = nativeA ? dxfMeasureNativeToBoardLive(nativeA, session, interaction.a.pieceIndex) : null;
      const boardB = nativeB ? dxfMeasureNativeToBoardLive(nativeB, session, interaction.a.pieceIndex) : null;
      if (boardA) drawDxfMeasureHandleLabeled(boardA, 'A');
      if (boardB) drawDxfMeasureHandleLabeled(boardB, 'B');
      return;
    }
    if (interaction.type === 'choosing-entity') {
      drawDxfMeasureEntityCandidates(session, interaction);
    }
  }
