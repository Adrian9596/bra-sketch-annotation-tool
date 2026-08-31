// ADR 0072: "Simplify piece" — merges redundant, near-perfectly-collinear
// runs of a piece's STRAIGHT segments into fewer, longer ones. A TD reported
// "trong piece còn nhiều điểm rác không cần thiết" (still many unnecessary
// junk points in the piece) after DXF import: a truly straight edge is often
// exported as many short collinear segments back-to-back. This does not
// change the piece's visible outline — only how many separate annotations
// draw it. Curved annotations are never touched: a DXF bulge/arc already
// becomes ONE cubic Bézier at import time (dxf-import.js), so there is no
// equivalent "many redundant points" problem on the curve side to solve here.
// Source part for app.js. Run `npm run build` after editing.
//
// Deliberately conservative: only segments within
// SIMPLIFY_COLLINEAR_ANGLE_DEG of perfectly straight-through are merged, and
// only through a point where EXACTLY one continuing segment exists (a real
// junction — 0, or 2+ other segments meeting there — always stops a chain).
// A genuine polygon corner is never smoothed away by this.

  const SIMPLIFY_COLLINEAR_ANGLE_DEG = 1;
  // 0.01 world-unit coincidence tolerance for "these are the same point" —
  // DXF-imported segments that share a real vertex land on it near-exactly
  // (same source coordinate, just Y-flipped/transformed identically), unlike
  // dxfConnectedComponents' much looser touch tolerance, which exists to
  // catch segments that only ALMOST meet.
  const SIMPLIFY_POINT_SCALE = 100;

  function simplifyPointKey(p) {
    return Math.round(p.x * SIMPLIFY_POINT_SCALE) + ',' + Math.round(p.y * SIMPLIFY_POINT_SCALE);
  }

  function simplifyAngleDeg(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  }

  function simplifyAngleDiffDeg(a, b) {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  }

  // Merges one piece's collinear straight-segment runs in place. Returns
  // {chains, removed} — chains merged, and how many annotations that freed
  // up (each N-segment run becomes 1, so removed = sum(N) - chains).
  function simplifyPieceGroup(groupId) {
    const straights = state.annotations.filter(a => a.templateGroupId === groupId && a.type === 'straight');
    if (straights.length < 2) return { chains: 0, removed: 0 };

    // endpoint key -> every {segId, other} touching that point
    const atPoint = new Map();
    const addEndpoint = (p, other, segId) => {
      const k = simplifyPointKey(p);
      if (!atPoint.has(k)) atPoint.set(k, []);
      atPoint.get(k).push({ segId, other });
    };
    for (const s of straights) {
      addEndpoint(s.start, s.end, s.id);
      addEndpoint(s.end, s.start, s.id);
    }

    const used = new Set();
    const neighborsAt = (k, excludeId) => (atPoint.get(k) || [])
      .filter(c => c.segId !== excludeId && !used.has(c.segId));

    const runs = [];
    for (const seg of straights) {
      if (used.has(seg.id)) continue;
      // Skip this segment as a chain START if it continues BACKWARD into
      // exactly one collinear neighbor — that neighbor's own walk (or an
      // earlier segment further back in the same run) will reach it.
      const backNeighbors = neighborsAt(simplifyPointKey(seg.start), seg.id);
      if (backNeighbors.length === 1) {
        const backDir = simplifyAngleDeg(seg.end, seg.start);
        const nDir = simplifyAngleDeg(seg.start, backNeighbors[0].other);
        if (simplifyAngleDiffDeg(backDir, nDir) <= SIMPLIFY_COLLINEAR_ANGLE_DEG) continue;
      }

      used.add(seg.id);
      const sourceIds = new Set([seg.id]);
      const points = [seg.start, seg.end];
      let currentDir = simplifyAngleDeg(seg.start, seg.end);
      let tail = seg.end;
      for (;;) {
        const fwd = neighborsAt(simplifyPointKey(tail), null);
        if (fwd.length !== 1) break;
        const nDir = simplifyAngleDeg(tail, fwd[0].other);
        if (simplifyAngleDiffDeg(currentDir, nDir) > SIMPLIFY_COLLINEAR_ANGLE_DEG) break;
        used.add(fwd[0].segId);
        sourceIds.add(fwd[0].segId);
        points.push(fwd[0].other);
        tail = fwd[0].other;
        currentDir = nDir;
      }
      if (points.length > 2) runs.push({ points, sourceIds, template: seg });
    }

    if (!runs.length) return { chains: 0, removed: 0 };

    let removed = 0;
    for (const run of runs) {
      const replacement = Object.assign({}, run.template, {
        id: state.idCounter++,
        start: run.points[0],
        end: run.points[run.points.length - 1],
      });
      replacement.label = computeDefaultLabelPosition(replacement);
      state.annotations = state.annotations.filter(a => !run.sourceIds.has(a.id));
      state.annotations.push(replacement);
      removed += run.sourceIds.size - 1;
    }
    // findings-dxf.md Finding 7: a merged run can consume the piece's
    // measure-session anchor annotation id, silently detaching the Pattern
    // Measure overlay from the piece's real position (dxfMeasureCurrentPieceOffset
    // falls back to {0,0} for a missing anchor rather than flagging it stale).
    // Placed here (not the caller) so any future caller of this mutator —
    // debug hook included — gets the same guarantee removePatternPieceGroups
    // already has.
    if (typeof dxfMeasureInvalidateOnPieceEdit === 'function') dxfMeasureInvalidateOnPieceEdit();
    return { chains: runs.length, removed };
  }
