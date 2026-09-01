// US-112: Pattern Measure snap modes — endpoint / midpoint / intersection
// snap targets computed from the SAME native geometry dxf-measure-session.js
// and the kernel (src/geometry/dxf-path-kernel.js) already treat as
// measurement authority. A snap candidate is a PREVIEW the TD sees before
// clicking (drawn by drawDxfMeasureSnapHover in render-dxf-measurements.js);
// it never resolves an ambiguity silently on its own — when a snap point is
// shared by several native entities (e.g. two segments meeting at a piece
// corner), dxfMeasureResolveEntityClick still runs its existing Tab/Enter
// choosing-entity flow against exactly those entities (see
// dxf-measure-interaction.js's dxfMeasureSnapEntityHitsForClick), same as an
// unsnapped click with several entities in tolerance. Snap only narrows WHERE
// the click is anchored, never who gets to decide between several entities.
// US-114 extended that same rule to snap points from DIFFERENT pieces near-
// coinciding (real grading-nest files stack every size's pieces at the same
// board position — ADR 0069/0070 — so two sizes' matching vertices can sit a
// fraction of a grade-step apart): dxfMeasureSnapTieCandidates surfaces every
// candidate within a tight band of the best one, not just the single
// nearest, so that case ALSO goes through choosing-entity instead of a
// silent pick. See also dxfMeasurePieceIsActive (dxf-measure-session.js) —
// the TD's own "Size" filter, a non-destructive way to rule out the other
// sizes' pieces entirely rather than relying on Tab/Enter every time.
// Source part for app.js. Run `npm run build` after editing.
//
// Release-1 scope (see docs/stories/epics/E01-manual-mode/
// US-111-112-113-measure-enhancements-plan.md §3.2): endpoint, midpoint, and
// LINE×LINE / LINE×ARC interior intersections. ARC×ARC intersection and
// snapping during an EXISTING measurement's endpoint drag are explicitly out
// of scope — only new-measurement placement (Along Path A/B, Out of Path A/B)
// snaps. Dragging a placed endpoint keeps its pre-existing (unsnapped)
// behavior; a future story can extend snap there once this shape has proven
// out.

  const DXF_MEASURE_SNAP_TOLERANCE_PX = 10; // same screen-px convention as DXF_MEASURE_HIT_TOLERANCE_PX

  // A point strictly inside a segment's own span — excludes both endpoints
  // (already covered by endpoint snap) so intersection snap only ever fires
  // for a genuine interior crossing (a dart/style line cutting through an
  // outline edge), never for two adjacent outline segments touching at the
  // corner they already share.
  function dxfMeasureIsInteriorT(t) {
    return Number.isFinite(t) && t > 1e-4 && t < 1 - 1e-4;
  }

  // ---- Per-piece snap point index (endpoints + midpoints; intersections lazy) --

  // Endpoints are CLUSTERED by native distance (same tolerance the route
  // graph itself uses, session.topologyToleranceNative — see
  // dxfBuildPathGraph's own findOrCreateNode) so a corner shared by several
  // segments becomes ONE snap target carrying every segment's ref, not one
  // per segment. Midpoints are never clustered — each segment has exactly one,
  // by construction. `dxfPointOnSegment(seg, 0.5)` is deliberately the same
  // "geometric midpoint" definition ADR 0073's duplicate-edge collapse already
  // uses, not a re-derivation.
  function dxfMeasureBuildPieceSnapIndex(piece, tolerance) {
    const endpoints = [];
    const midpoints = [];
    const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1e-6;
    piece.segments.forEach((seg, segIndexInPiece) => {
      if (dxfSegmentFailureReason(seg)) return;
      const mid = dxfPointOnSegment(seg, 0.5);
      if (mid) midpoints.push({ native: mid, refs: [{ segIndexInPiece, t: 0.5 }] });
      for (const t of [0, 1]) {
        const p = dxfPointOnSegment(seg, t);
        if (!p) continue;
        let bucket = null;
        for (const e of endpoints) { if (distance(e.native, p) <= tol) { bucket = e; break; } }
        if (!bucket) { bucket = { native: p, refs: [] }; endpoints.push(bucket); }
        bucket.refs.push({ segIndexInPiece, t });
      }
    });
    return { endpoints, midpoints, intersections: null, duplicateCanonical: dxfMeasureDuplicateSegmentCanonical(piece, tol) };
  }

  // Found 2026-09-01 on a real production file authored as pairs of
  // back-to-back, byte-identical closed POLYLINEs (every piece's outline
  // drawn twice): ADR 0073's dxfCollapseDuplicateParallelEdges already
  // treats this as one edge for ROUTE SEARCH, but nothing did the same for
  // point-PLACEMENT — a click near such an edge's midpoint (or a corner it
  // shares with its own duplicate) hit BOTH copies within tolerance, and
  // dxfMeasureResolveEntityClick's no-silent-pick rule correctly, but
  // pointlessly, opened a Tab/Enter choice between two options that measure
  // identically either way. Reuses the exact same "genuine duplicate"
  // definition as dxfCollapseDuplicateParallelEdges (same kind, same
  // length, same geometric midpoint, within `tolerance`) rather than a
  // second heuristic — this just applies it to the flat per-piece segment
  // list instead of the route-search graph. Returns canonical[i] === i for
  // every segment with no duplicate, so callers can always index it safely.
  function dxfMeasureDuplicateSegmentCanonical(piece, tolerance) {
    const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 1e-6;
    const canonical = new Array(piece.segments.length);
    const groups = [];
    piece.segments.forEach((seg, segIndexInPiece) => {
      if (dxfSegmentFailureReason(seg)) { canonical[segIndexInPiece] = segIndexInPiece; return; }
      const length = dxfSegmentLength(seg);
      const mid = dxfPointOnSegment(seg, 0.5);
      const lenEps = Math.max(tol, Math.abs(length) * 1e-9);
      const match = mid && groups.find(g => g.kind === seg.kind
        && Math.abs(g.length - length) <= lenEps
        && distance(g.mid, mid) <= tol);
      if (match) {
        canonical[segIndexInPiece] = match.segIndexInPiece;
      } else {
        canonical[segIndexInPiece] = segIndexInPiece;
        groups.push({ kind: seg.kind, length, mid, segIndexInPiece });
      }
    });
    return canonical;
  }

  // The candidate/hit list a click actually resolves against, with any
  // hits that map to the SAME piece's canonical duplicate segment collapsed
  // to one (keeping the first — callers pass hits already sorted nearest-
  // first, or effectively tied at distance 0 for a true duplicate). See
  // dxfMeasureDuplicateSegmentCanonical above for why: two authored copies
  // of one edge are not two different entities for choosing-entity to make
  // a TD pick between.
  function dxfMeasureCollapseDuplicateSegmentHits(session, hits) {
    if (!Array.isArray(hits) || hits.length < 2) return hits;
    const seen = new Set();
    const kept = [];
    for (const hit of hits) {
      const idx = dxfMeasureEnsurePieceSnapIndex(session, hit.pieceIndex);
      const canonicalSeg = (idx.duplicateCanonical && idx.duplicateCanonical[hit.segIndexInPiece] != null)
        ? idx.duplicateCanonical[hit.segIndexInPiece] : hit.segIndexInPiece;
      const key = hit.pieceIndex + ':' + canonicalSeg;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(hit);
    }
    return kept;
  }

  // Circle/line intersection: solve |P0 + t*D - C|^2 = r^2 for t, keep roots
  // within the LINE's own [0,1] span, then reject any root whose angle (as
  // seen from the arc's center) falls outside the arc's swept range using the
  // SAME unclamped dxfAngleParamOnSweep the kernel already uses for
  // point-on-arc projection — an arcT outside [0,1] means the circle point is
  // real but on the unswept remainder of the full circle, not on this arc.
  function dxfMeasureLineArcIntersections(lineSeg, arcSeg) {
    const D = { x: lineSeg.b.x - lineSeg.a.x, y: lineSeg.b.y - lineSeg.a.y };
    const f = { x: lineSeg.a.x - arcSeg.center.x, y: lineSeg.a.y - arcSeg.center.y };
    const a = D.x * D.x + D.y * D.y;
    if (a < 1e-12) return [];
    const b = 2 * (f.x * D.x + f.y * D.y);
    const c = f.x * f.x + f.y * f.y - arcSeg.radius * arcSeg.radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    const sq = Math.sqrt(Math.max(0, disc));
    const roots = disc < 1e-12 ? [(-b) / (2 * a)] : [(-b + sq) / (2 * a), (-b - sq) / (2 * a)];
    const results = [];
    for (const t of roots) {
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      const lineT = clamp(t, 0, 1);
      const point = { x: lineSeg.a.x + lineT * D.x, y: lineSeg.a.y + lineT * D.y };
      const angle = Math.atan2(point.y - arcSeg.center.y, point.x - arcSeg.center.x);
      const arcT = dxfAngleParamOnSweep(angle, arcSeg.startAngle, arcSeg.sweep);
      if (arcT < -1e-6 || arcT > 1 + 1e-6) continue;
      results.push({ point, lineT, arcT: clamp(arcT, 0, 1) });
    }
    return results;
  }

  // Every pairwise LINE×LINE and LINE×ARC crossing within one piece, filtered
  // to INTERIOR crossings only (dxfMeasureIsInteriorT on both sides) — see
  // file header. O(segments^2) pairwise, same complexity class as
  // dxfBuildPathGraph's own node clustering; computed once per piece, only
  // once the TD turns Intersection snap on, and cached (dxfMeasureEnsurePiece
  // IntersectionIndex) — never recomputed per pointermove. ARC×ARC pairs are
  // skipped (out of scope, see file header).
  function dxfMeasureBuildPieceIntersections(piece) {
    const segs = piece.segments;
    const out = [];
    for (let i = 0; i < segs.length; i += 1) {
      const A = segs[i];
      if (dxfSegmentFailureReason(A)) continue;
      for (let j = i + 1; j < segs.length; j += 1) {
        const B = segs[j];
        if (dxfSegmentFailureReason(B)) continue;
        if (A.kind === 'straight' && B.kind === 'straight') {
          const p = segmentIntersection(A.a, A.b, B.a, B.b);
          if (!p) continue;
          const tA = dxfProjectPointOnStraight(p, A).t;
          const tB = dxfProjectPointOnStraight(p, B).t;
          if (dxfMeasureIsInteriorT(tA) && dxfMeasureIsInteriorT(tB)) {
            out.push({ native: p, refs: [{ segIndexInPiece: i, t: tA }, { segIndexInPiece: j, t: tB }] });
          }
        } else if (A.kind === 'straight' && B.kind === 'arc') {
          for (const hit of dxfMeasureLineArcIntersections(A, B)) {
            if (dxfMeasureIsInteriorT(hit.lineT) && dxfMeasureIsInteriorT(hit.arcT)) {
              out.push({ native: hit.point, refs: [{ segIndexInPiece: i, t: hit.lineT }, { segIndexInPiece: j, t: hit.arcT }] });
            }
          }
        } else if (A.kind === 'arc' && B.kind === 'straight') {
          for (const hit of dxfMeasureLineArcIntersections(B, A)) {
            if (dxfMeasureIsInteriorT(hit.lineT) && dxfMeasureIsInteriorT(hit.arcT)) {
              out.push({ native: hit.point, refs: [{ segIndexInPiece: j, t: hit.lineT }, { segIndexInPiece: i, t: hit.arcT }] });
            }
          }
        }
        // ARC×ARC: out of scope for Release 1 — see file header.
      }
    }
    return out;
  }

  function dxfMeasureEnsurePieceSnapIndex(session, pieceIndex) {
    if (!session.snapIndex) session.snapIndex = { byPiece: session.pieces.map(() => null) };
    if (!session.snapIndex.byPiece[pieceIndex]) {
      session.snapIndex.byPiece[pieceIndex] = dxfMeasureBuildPieceSnapIndex(session.pieces[pieceIndex], session.topologyToleranceNative);
    }
    return session.snapIndex.byPiece[pieceIndex];
  }

  function dxfMeasureEnsurePieceIntersectionIndex(session, pieceIndex) {
    const idx = dxfMeasureEnsurePieceSnapIndex(session, pieceIndex);
    if (!idx.intersections) idx.intersections = dxfMeasureBuildPieceIntersections(session.pieces[pieceIndex]);
    return idx.intersections;
  }

  // ---- Live candidate lookup (called from click resolution + hover render) --

  function dxfMeasureSnapEnabledKinds() {
    const kinds = [];
    if (state.dxfMeasureSnapEndpoint) kinds.push('endpoint');
    if (state.dxfMeasureSnapMidpoint) kinds.push('midpoint');
    if (state.dxfMeasureSnapIntersection) kinds.push('intersection');
    return kinds;
  }

  function dxfMeasureAnySnapEnabled() {
    return !!(state.dxfMeasureSnapEndpoint || state.dxfMeasureSnapMidpoint || state.dxfMeasureSnapIntersection);
  }

  // Every enabled-kind snap point within DXF_MEASURE_SNAP_TOLERANCE_PX screen
  // px of `world` (board/world space, live piece position already accounted
  // for via dxfMeasureNativeToBoardLive), sorted nearest-first and scoped to
  // the active size filter (dxfMeasurePieceIsActive, US-114) exactly like
  // every other piece-search in this session. `dxfMeasureSnapCandidate`
  // (singular, below) keeps returning just the nearest for callers that only
  // ever wanted one point (the hover preview, Out of Path placement); this
  // plural form exists for dxfMeasureSnapTieCandidates' near-tie check below.
  function dxfMeasureSnapCandidates(session, world) {
    if (!session || !world) return [];
    const kinds = dxfMeasureSnapEnabledKinds();
    if (!kinds.length) return [];
    const tol = DXF_MEASURE_SNAP_TOLERANCE_PX / Math.max(0.0001, state.zoom);
    const all = [];
    session.pieces.forEach((piece, pieceIndex) => {
      if (!piece.segments.length || !dxfMeasurePieceIsActive(session, pieceIndex)) return;
      const idx = dxfMeasureEnsurePieceSnapIndex(session, pieceIndex);
      // Computed ONCE per piece, not once per snap point — see
      // dxfMeasureNativeToBoardLive's own comment on why this matters.
      const offset = dxfMeasureCurrentPieceOffset(session, pieceIndex);
      const pools = [];
      if (kinds.includes('endpoint')) pools.push(['endpoint', idx.endpoints]);
      if (kinds.includes('midpoint')) pools.push(['midpoint', idx.midpoints]);
      if (kinds.includes('intersection')) pools.push(['intersection', dxfMeasureEnsurePieceIntersectionIndex(session, pieceIndex)]);
      for (const [kind, points] of pools) {
        for (const point of points) {
          const board = dxfMeasureNativeToBoardLive(point.native, session, pieceIndex, offset);
          if (!board) continue;
          const d = distance(world, board);
          if (d <= tol) all.push({ kind, pieceIndex, native: point.native, refs: point.refs, distance: d });
        }
      }
    });
    all.sort((a, b) => a.distance - b.distance);
    return all;
  }

  // Nearest enabled-kind snap point to `world`, or null. When several kinds
  // are in tolerance, the NEAREST wins regardless of kind — see the plan's
  // "ưu tiên gần pointer nhất" rule; the caller always draws a marker exactly
  // at the returned point before it can be committed by a click, so this is
  // a visible preview, never a silent guess (file header).
  function dxfMeasureSnapCandidate(session, world) {
    const all = dxfMeasureSnapCandidates(session, world);
    return all.length ? all[0] : null;
  }

  // A near-tie band around the single best candidate. Two DIFFERENT pieces'
  // snap points landing this close together happens in practice on real
  // grading-nest files — confirmed as close as 0.06 native units apart on a
  // real factory file (two adjacent graded sizes' matching vertices), well
  // under any realistic hand-click precision. Deliberately smaller than
  // DXF_MEASURE_SNAP_TOLERANCE_PX itself (10px): that full radius already has
  // its own long-standing "just take the nearest" behavior for the ordinary
  // single-piece case (e.g. an endpoint narrowly beating a nearby midpoint),
  // and treating every in-tolerance point as ambiguous would be a regression
  // for that case, not a fix — this band exists only to catch genuine
  // near-total coincidences, not "merely nearby" candidates.
  const DXF_MEASURE_SNAP_TIE_TOLERANCE_PX = 2;

  // The candidate set a click should actually resolve against: just the
  // best one when it has no close rival, or every candidate within
  // DXF_MEASURE_SNAP_TIE_TOLERANCE_PX of it when it does. Handed to
  // dxfMeasureSnapEntityHitsForClick (dxf-measure-interaction.js) to build
  // the SAME choosing-entity hits list an unsnapped click already produces —
  // see this file's header: snap must never silently pick between several
  // entities on its own.
  function dxfMeasureSnapTieCandidates(session, world) {
    const all = dxfMeasureSnapCandidates(session, world);
    if (all.length <= 1) return all;
    const tieTol = DXF_MEASURE_SNAP_TIE_TOLERANCE_PX / Math.max(0.0001, state.zoom);
    const bestDistance = all[0].distance;
    return all.filter(candidate => candidate.distance <= bestDistance + tieTol);
  }

  // ---- Menu toggles (same pattern as toggleSmartAlign) -----------------------

  function dxfMeasureSetSnapKind(kind, enabled) {
    const key = kind === 'endpoint' ? 'dxfMeasureSnapEndpoint'
      : kind === 'midpoint' ? 'dxfMeasureSnapMidpoint'
      : kind === 'intersection' ? 'dxfMeasureSnapIntersection' : null;
    if (!key) return;
    state[key] = !!enabled;
    updateUI();
    requestRender();
  }

  function toggleDxfMeasureSnapKind(kind) {
    const current = kind === 'endpoint' ? state.dxfMeasureSnapEndpoint
      : kind === 'midpoint' ? state.dxfMeasureSnapMidpoint
      : state.dxfMeasureSnapIntersection;
    dxfMeasureSetSnapKind(kind, !current);
  }
