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

  // findings-dxf.md Finding 10. The joint test above compares each segment
  // with the one BEFORE it, so on its own it let a run bend by up to 1° at
  // every joint: a pattern curve exported as LINE facets (the normal case)
  // became one straight chord. On the 45-file corpus that removed 22,023
  // segments, one run turned 92° and a dropped vertex sat 53 mm off its
  // replacement — ADR 0072 promised the opposite. So a run may also only
  // grow while EVERY vertex it would drop stays within
  // SIMPLIFY_MAX_DEVIATION_RATIO x chord length of the new chord — a bound
  // on the run as a whole, which no number of small joints can add up past.
  const SIMPLIFY_MAX_DEVIATION_RATIO = 1e-4;

  function simplifyMaxDeviation(points, next) {
    const a = points[0];
    const len = Math.hypot(next.x - a.x, next.y - a.y);
    if (!(len > 0)) return Infinity;
    let worst = 0;
    for (let i = 1; i < points.length; i += 1) {
      const p = points[i];
      const d = Math.abs((next.x - a.x) * (a.y - p.y) - (a.x - p.x) * (next.y - a.y)) / len;
      if (d > worst) worst = d;
    }
    return worst / len;
  }

  // Merges one piece's collinear straight-segment runs in place. Returns
  // {chains, removed} — chains merged, and how many annotations that freed
  // up (each N-segment run becomes 1, so removed = sum(N) - chains).
  function simplifyPieceGroup(groupId) {
    const groupAnns = state.annotations.filter(a => a.templateGroupId === groupId);
    const straights = groupAnns.filter(a => a.type === 'straight');
    if (straights.length < 2) return { chains: 0, removed: 0 };

    // endpoint key -> every {segId, at, other} touching that point
    const atPoint = new Map();
    const addEndpoint = (p, other, segId) => {
      const k = simplifyPointKey(p);
      if (!atPoint.has(k)) atPoint.set(k, []);
      atPoint.get(k).push({ segId, at: p, other });
    };
    for (const s of straights) {
      addEndpoint(s.start, s.end, s.id);
      addEndpoint(s.end, s.start, s.id);
    }
    // A curve ending at a point makes it a junction even when only one other
    // STRAIGHT segment continues there (Finding 10's topology gap).
    const curveEnds = new Set();
    for (const a of groupAnns) {
      if (a.type === 'straight' || !a.start || !a.end) continue;
      curveEnds.add(simplifyPointKey(a.start));
      curveEnds.add(simplifyPointKey(a.end));
    }

    const used = new Set();
    const neighborsAt = (k, excludeId) => (atPoint.get(k) || [])
      .filter(c => c.segId !== excludeId && !used.has(c.segId));
    // The key is a 0.01 grid cell, so sharing one is not the same as sharing a
    // vertex: the continuing segment must start where this one ends, to
    // within the same bound a dropped vertex gets (no bridging a real gap).
    const joins = (tail, cand, chordLen) => Math.hypot(cand.at.x - tail.x, cand.at.y - tail.y)
      <= SIMPLIFY_MAX_DEVIATION_RATIO * chordLen;
    const continuesBackward = (seg) => {
      const k = simplifyPointKey(seg.start);
      if (curveEnds.has(k)) return false;
      const back = neighborsAt(k, seg.id);
      if (back.length !== 1) return false;
      return simplifyAngleDiffDeg(simplifyAngleDeg(seg.end, seg.start), simplifyAngleDeg(seg.start, back[0].other))
        <= SIMPLIFY_COLLINEAR_ANGLE_DEG;
    };

    const runs = [];
    const walkFrom = (seg) => {
      used.add(seg.id);
      const sourceIds = new Set([seg.id]);
      const points = [seg.start, seg.end];
      let currentDir = simplifyAngleDeg(seg.start, seg.end);
      let tail = seg.end;
      for (;;) {
        const tailKey = simplifyPointKey(tail);
        if (curveEnds.has(tailKey)) break;
        const fwd = neighborsAt(tailKey, null);
        if (fwd.length !== 1) break;
        const next = fwd[0].other;
        const nDir = simplifyAngleDeg(tail, next);
        if (simplifyAngleDiffDeg(currentDir, nDir) > SIMPLIFY_COLLINEAR_ANGLE_DEG) break;
        const chordLen = Math.hypot(next.x - points[0].x, next.y - points[0].y);
        if (!joins(tail, fwd[0], chordLen)) break;
        if (simplifyMaxDeviation(points, next) > SIMPLIFY_MAX_DEVIATION_RATIO) break;
        used.add(fwd[0].segId);
        sourceIds.add(fwd[0].segId);
        points.push(next);
        tail = next;
        currentDir = nDir;
      }
      if (points.length > 2) runs.push({ points, sourceIds, template: seg });
    };
    // A segment that continues backward into an unused collinear neighbour is
    // not a chain start — that neighbour's walk will reach it. But a walk can
    // now stop short (the deviation bound), which makes its successor a start
    // on the NEXT pass; repeat until nothing new starts, then let whatever is
    // left (a closed loop of facets has no natural start) start anywhere.
    for (let progress = true; progress;) {
      progress = false;
      for (const seg of straights) {
        if (used.has(seg.id) || continuesBackward(seg)) continue;
        walkFrom(seg);
        progress = true;
      }
    }
    for (const seg of straights) if (!used.has(seg.id)) walkFrom(seg);

    if (!runs.length) return { chains: 0, removed: 0 };

    let removed = 0;
    const merged = new Set();
    const replacements = [];
    for (const run of runs) {
      const replacement = Object.assign({}, run.template, {
        id: state.idCounter++,
        start: run.points[0],
        end: run.points[run.points.length - 1],
      });
      replacement.label = computeDefaultLabelPosition(replacement);
      // Before the sources go: a notch's current spot is read from its owner.
      reownNotchesToLine(run.sourceIds, replacement);
      for (const id of run.sourceIds) merged.add(id);
      replacements.push(replacement);
      removed += run.sourceIds.size - 1;
    }
    // One pass for every run (same final order as removing run by run).
    state.annotations = state.annotations.filter(a => !merged.has(a.id)).concat(replacements);
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
