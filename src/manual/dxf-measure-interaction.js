// US-105: DXF Pattern Measurement — the "Pattern Measure" tool's pointer +
// keyboard interaction. Owns session.interaction (a session-scoped gesture
// record, deliberately separate from state.interaction — Pattern Measure
// works against native (pieceIndex, segIndexInPiece, t) references, not
// board annotations, and must never touch state.annotations while active).
// Entry points are called from pointer-events.js/keyboard-shortcuts.js only
// while state.tool === 'pattern-measure'.
// Source part for app.js. Run `npm run build` after editing.
//
// CLAUDE_REWORK_CHECKLIST.md RB-1/RB-2/RB-3 rewrote this file's placement
// and drag flows around three decoupled ideas:
//  - A/B are IDENTITIES (measurement.a / measurement.b), never re-derived
//    from route-point array order — `direction` is a pure arrow-rendering
//    flag, `routeCandidateIndex` is the TD's actual chosen candidate (into a
//    canonical A-to-B enumeration), and the two never encode each other.
//  - Any point where more than one native entity is a valid click target
//    (RB-2) or more than one route connects A to B (RB-1) is an explicit,
//    keyboard-driven choice — never `hits[0]` / `routes[0]`.
//  - Endpoint drag is transactional (RB-3): mousemove only ever updates a
//    SCRATCH preview (session.interaction.preview); the real measurement is
//    mutated exactly once, at the moment a drag or a candidate choice
//    resolves unambiguously.

  const DXF_MEASURE_HIT_TOLERANCE_PX = 10; // screen px, matches the existing endpoint/handle catch radius convention

  function dxfMeasureToleranceWorld() {
    return DXF_MEASURE_HIT_TOLERANCE_PX / Math.max(0.0001, state.zoom);
  }

  // ---- Where a measurement's handles/label/route currently render ----------
  //
  // Every one of these consults a live drag preview FIRST (dxfMeasureDragPreviewFor)
  // so a completed measurement's own committed a/b/route is never mutated
  // mid-gesture (RB-3) while the on-canvas feedback still tracks the cursor.

  // The in-progress drag preview for `measurementId`, or null if no drag is
  // active for it. See dxfMeasureRecomputeDragPreview for `preview`'s shape.
  function dxfMeasureDragPreviewFor(session, measurementId) {
    const interaction = session && session.interaction;
    if (!interaction || interaction.type !== 'drag-endpoint' || interaction.measurementId !== measurementId) return null;
    return interaction.preview || null;
  }

  // True while a drag is in progress but the CURRENT hover position does not
  // resolve to a valid endpoint/route — used by the renderer to tint the
  // route red instead of silently keeping the last géometry on screen.
  function dxfMeasureDragInvalidFor(session, measurementId) {
    const preview = dxfMeasureDragPreviewFor(session, measurementId);
    return !!(preview && preview.status !== 'ok');
  }

  function dxfMeasureNativePointForRef(session, ref) {
    if (!session || !ref) return null;
    const piece = session.pieces[ref.pieceIndex];
    const seg = piece && piece.segments[ref.segIndexInPiece];
    return seg ? dxfPointOnSegment(seg, ref.t) : null;
  }

  function dxfMeasureHandleWorldPos(session, measurement, which) {
    const preview = dxfMeasureDragPreviewFor(session, measurement.id);
    if (preview && preview.status === 'ok') {
      if (measurement.mode === 'out-of-path') {
        const isDraggedEnd = session.interaction.which === which;
        const endpoint = isDraggedEnd ? preview.endpoint : measurement[which];
        return endpoint.pieceIndex == null
          ? dxfMeasureNativeToBoard(endpoint.native, session)
          : dxfMeasureNativeToBoardLive(endpoint.native, session, endpoint.pieceIndex);
      }
      const ref = which === 'a' ? preview.refA : preview.refB;
      const native = dxfMeasureNativePointForRef(session, ref);
      return native ? dxfMeasureNativeToBoardLive(native, session, ref.pieceIndex) : null;
    }
    const endpoint = measurement[which];
    if (!endpoint) return null;
    if (measurement.mode === 'out-of-path') {
      return endpoint.pieceIndex == null
        ? dxfMeasureNativeToBoard(endpoint.native, session)
        : dxfMeasureNativeToBoardLive(endpoint.native, session, endpoint.pieceIndex);
    }
    return dxfMeasureNativeToBoardLive(endpoint.native, session, endpoint.pieceIndex);
  }

  // Ordered board-space points tracing exactly the route a completed
  // measurement's value was computed from — the render layer draws this
  // same list, so "the highlighted route is exactly the route measured"
  // holds by construction (one shared function, not two independently
  // written paths). Always in canonical A-to-B order (see file header) —
  // `direction` never reorders this array; the renderer picks which END gets
  // the arrowhead instead (drawDxfMeasureDirectionArrow).
  function dxfMeasureRouteWorldPoints(session, measurement, samplesPerStep) {
    if (!session || !measurement) return [];
    if (measurement.mode === 'out-of-path') {
      const a = dxfMeasureHandleWorldPos(session, measurement, 'a');
      const b = dxfMeasureHandleWorldPos(session, measurement, 'b');
      return a && b ? [a, b] : [];
    }
    const preview = dxfMeasureDragPreviewFor(session, measurement.id);
    const live = preview && preview.status === 'ok';
    const route = live ? preview.route : measurement.route;
    const pieceIndex = live ? preview.refA.pieceIndex : (measurement.a && measurement.a.pieceIndex);
    if (!route) return [];
    const piece = session.pieces[pieceIndex];
    if (!piece) return [];
    const n = samplesPerStep || 12;
    const points = [];
    // Computed ONCE for the whole route, not once per sample point — see
    // dxfMeasureNativeToBoardLive's own comment (same fix as US-114/ADR 0077
    // applied to dxfMeasureSnapCandidates; this render path has the identical
    // "same pieceIndex, many points" shape, just per-frame instead of
    // per-hover).
    const offset = dxfMeasureCurrentPieceOffset(session, pieceIndex);
    for (const step of route.steps) {
      const seg = piece.segments[step.segIndex];
      if (!seg) continue;
      for (let i = 0; i <= n; i += 1) {
        const t = step.t0 + (step.t1 - step.t0) * (i / n);
        const board = dxfMeasureNativeToBoardLive(dxfPointOnSegment(seg, t), session, pieceIndex, offset);
        if (board) points.push(board);
      }
    }
    return points;
  }

  // Default label anchor: the midpoint (by point count along the sampled
  // route — adequate for a compact value pill, not a measurement itself) for
  // Along Path, or the straight midpoint for Out of Path. A manually-dragged
  // label stores labelOffset as a board-space delta FROM this anchor, so the
  // label stays correctly positioned even if the piece itself later moves
  // (the anchor moves with dxfMeasureNativeToBoardLive; the delta is applied
  // on top of wherever that lands).
  function dxfMeasureLabelAnchorWorldPos(session, measurement) {
    const pts = dxfMeasureRouteWorldPoints(session, measurement, 12);
    if (!pts.length) return null;
    return pts[Math.floor(pts.length / 2)];
  }

  function dxfMeasureLabelWorldPos(session, measurement) {
    const anchor = dxfMeasureLabelAnchorWorldPos(session, measurement);
    if (!anchor) return null;
    if (!measurement.labelOffset) return { x: anchor.x + 14 / state.zoom, y: anchor.y - 20 / state.zoom };
    return { x: anchor.x + measurement.labelOffset.x, y: anchor.y + measurement.labelOffset.y };
  }

  // The numeric value to DISPLAY right now — the committed value, unless a
  // live, currently-valid drag preview exists for this measurement, in which
  // case the preview's own candidate geometry is measured instead. Never
  // mutates `measurement` (RB-3) — this is read-only, display-time math.
  function dxfMeasureDisplayValueInches(session, measurement) {
    const preview = dxfMeasureDragPreviewFor(session, measurement.id);
    if (preview && preview.status === 'ok') {
      const factor = dxfMeasureEffectiveUnitFactor(session);
      let nativeLength = null;
      if (measurement.mode === 'out-of-path') {
        const which = session.interaction.which;
        const otherNative = which === 'a' ? measurement.b.native : measurement.a.native;
        nativeLength = dxfDirectDistance(preview.endpoint.native, otherNative);
      } else {
        const piece = session.pieces[preview.refA.pieceIndex];
        nativeLength = piece ? dxfRouteLength(preview.route, piece.segments) : null;
      }
      return Number.isFinite(nativeLength) && Number.isFinite(factor) ? nativeLength * factor : null;
    }
    return dxfMeasureValueInches(session, measurement);
  }

  // ---- Hit-testing (handle > label > route body > new placement) -----------

  function dxfMeasureHitTestHandle(session, world, tol) {
    // Only the active measurement renders A/B handles. Hidden handles from
    // inactive measurements must not remain invisible hit targets underneath
    // the visible one (two measurements may deliberately share A/B).
    const m = dxfMeasureGetMeasurement(session, session.selectedMeasurementId);
    if (!m) return null;
    let best = null;
    for (const which of ['a', 'b']) {
      const p = dxfMeasureHandleWorldPos(session, m, which);
      const d = p ? distance(world, p) : Infinity;
      if (d <= tol && (!best || d < best.distance)) best = { measurementId: m.id, which, distance: d };
    }
    return best ? { measurementId: best.measurementId, which: best.which } : null;
  }

  function dxfMeasureHitTestLabel(session, world, tol) {
    for (const m of session.measurements) {
      const p = dxfMeasureLabelWorldPos(session, m);
      if (p && distance(world, p) <= tol) return { measurementId: m.id };
    }
    return null;
  }

  function dxfMeasureHitTestRouteBody(session, world, tol) {
    for (const m of session.measurements) {
      const pts = dxfMeasureRouteWorldPoints(session, m, 12);
      for (let i = 0; i < pts.length - 1; i += 1) {
        if (pointToSegmentDistance(world, pts[i], pts[i + 1]) <= tol) return { measurementId: m.id };
      }
    }
    return null;
  }

  // ---- Entity hit-testing: every in-tolerance candidate, never hits[0] -----

  // RB-2: the raw, unfiltered candidate set for a click — 0, 1, or several
  // native segments within tolerance. Returning ALL of them (not just the
  // nearest) is what lets the caller tell "unambiguous" from "needs a human
  // choice" apart; picking hits[0] here would be exactly the silent-guess
  // behavior the checklist forbids.
  function dxfMeasureEntityHitsForClick(session, world) {
    const hits = dxfMeasureHitTestNativeSegments(session, world, dxfMeasureToleranceWorld());
    return dxfMeasureCollapseDuplicateSegmentHits(session, hits);
  }

  function dxfMeasureRefFromHit(hit) {
    return { pieceIndex: hit.pieceIndex, segIndexInPiece: hit.segIndexInPiece, t: hit.t };
  }

  // US-112: the candidate set a click resolves against — the snapped point's
  // own refs when a snap target is active (so a corner shared by several
  // segments still goes through the normal choosing-entity Tab/Enter flow
  // below, just anchored at the exact corner instead of wherever within
  // tolerance the raw click landed), otherwise the unsnapped tolerance-radius
  // hits exactly as before this story. `altBypass` (Alt/Option held) skips
  // snapping for this one click, matching Smart Align's own bypass gesture.
  function dxfMeasureSnapEntityHitsForClick(session, world, altBypass) {
    if (!altBypass) {
      // US-114: every near-tied candidate (usually just the one), not only
      // the single nearest — see dxfMeasureSnapTieCandidates for why.
      const ties = dxfMeasureSnapTieCandidates(session, world);
      if (ties.length) {
        const hits = ties.flatMap(snap => snap.refs.map(ref =>
          ({ pieceIndex: snap.pieceIndex, segIndexInPiece: ref.segIndexInPiece, t: ref.t, distance: 0 })));
        return dxfMeasureCollapseDuplicateSegmentHits(session, hits);
      }
    }
    return dxfMeasureEntityHitsForClick(session, world);
  }

  // ---- Route/direction candidate construction (RB-1) -------------------------
  //
  // Unifies "choose which of several routes" and "choose forward vs reverse
  // on a single-route open path" into ONE candidate list the same Tab/Enter
  // machinery already built for route-choosing drives — see the checklist's
  // "add a small transient direction/route chooser for a one-route open
  // path": rather than a second UI construct, a 1-route result gets two
  // VIRTUAL candidates (same route, opposite arrow) instead of silently
  // auto-committing as 'forward'. `direction` here is a pure arrow flag —
  // never "index === 1 means reverse" (the exact assumption RB-1 forbids).
  function dxfMeasureBuildDirectionCandidates(routes, segments) {
    if (routes.length === 1) {
      return [{ routeIndex: 0, direction: 'forward' }, { routeIndex: 0, direction: 'reverse' }];
    }
    const ranked = routes.map((route, routeIndex) => ({
      routeIndex,
      score: dxfRouteAuthoredDirectionScore(route, segments),
      identity: dxfMeasureRouteIdentity(route),
    })).sort((a, b) => a.score - b.score || a.identity.localeCompare(b.identity));
    const midpoint = (ranked[0].score + ranked[ranked.length - 1].score) / 2;
    const directions = new Map(ranked.map((item, rank) => [item.routeIndex,
      rank === 0 ? 'reverse' : rank === ranked.length - 1 ? 'forward' : (item.score < midpoint ? 'reverse' : 'forward')]));
    return routes.map((_, routeIndex) => ({ routeIndex, direction: directions.get(routeIndex) }));
  }

  function dxfMeasureRouteIdentity(route) {
    return route && Array.isArray(route.steps) ? route.steps.map(step => step.segIndex).join('>') : '';
  }

  function dxfMeasurePreferredCandidateIndex(measurement, routes, candidates) {
    if (!measurement || !measurement.route) return 0;
    const identity = dxfMeasureRouteIdentity(measurement.route);
    const candidateIndex = candidates.findIndex(candidate => dxfMeasureRouteIdentity(routes[candidate.routeIndex]) === identity
      && candidate.direction === measurement.direction);
    return candidateIndex >= 0 ? candidateIndex : 0;
  }

  function dxfMeasureRouteChoiceToast(routeCount, truncated) {
    if (truncated) {
      return routeCount + '+ routes found (route search capped — not the complete set) — Tab to cycle, Enter to choose, Escape to cancel.';
    }
    if (routeCount === 1) return 'Choose a direction — Tab to cycle Forward/Reverse, Enter to choose, Escape to cancel.';
    if (routeCount === 2) return '2 routes found (complementary directions) — Tab to cycle, Enter to choose, Escape to cancel.';
    return routeCount + ' routes found — Tab to cycle, Enter to choose, Escape to cancel.';
  }

  // ---- Placement (Along Path / Out of Path) ----------------------------------

  function dxfMeasureFinishAlongPath(session, refA, refB, route, direction, routeCandidateIndex, routeCandidateCount) {
    const measurement = dxfMeasureCreateAlongPathMeasurement(session, refA, refB, route, direction, routeCandidateIndex, routeCandidateCount);
    if (!measurement) return;
    session.selectedMeasurementId = measurement.id;
    session.interaction = null;
    updateUI();
    requestRender();
  }

  // Runs route enumeration for a (refA, refB) pair the TD has already picked
  // (both entity-unambiguous) and either fails with a toast (leaving
  // `session.interaction` as whatever it already was, so the TD can retry B
  // without re-placing A) or enters the unified direction/route chooser —
  // ALWAYS, even for a single route, so "an open path with one route is
  // committed as forward immediately" (RB-1's defect #1) cannot recur.
  function dxfMeasureResolveAlongPathPair(session, refA, refB) {
    const result = dxfMeasureEnumerateRoutes(session, refA, refB);
    if (!result.ok || !result.routes.length) {
      showToast(result.reason === DXF_MEASURE_REASON.NO_CONNECTED_PATH
        ? 'Point B is not on the same connected path as point A.'
        : result.reason === DXF_MEASURE_REASON.ROUTE_SEARCH_TRUNCATED
          ? 'This A–B pair has too many routes to prove completely. Measurement canceled; choose different endpoints.'
          : result.reason === DXF_MEASURE_REASON.SAME_POINT
            // ADR 0084: on a closed loop this same click pair measures the
            // whole way around; only an open path has nothing between A and A.
            ? 'Point B is the same point as A on an open edge — nothing to measure between them. Click a different point for B.'
            : 'Could not measure between those two points.');
      return;
    }
    const piece = session.pieces[refA.pieceIndex];
    const candidates = dxfMeasureBuildDirectionCandidates(result.routes, piece && piece.segments);
    session.interaction = {
      type: 'choosing-route', mode: 'along-path', a: refA, b: refB,
      routes: result.routes, truncated: result.truncated, candidates, chosenIndex: 0,
    };
    showToast(dxfMeasureRouteChoiceToast(result.routes.length, result.truncated));
    updateUI();
    requestRender();
  }

  // Resolves one endpoint click into a single unambiguous ref, entering
  // `choosing-entity` (RB-2) instead of guessing whenever more than one
  // native entity is within tolerance. `onResolved(ref)` runs only once the
  // TD's intended entity is unambiguous — either immediately (0 or 1 hit) or
  // after an explicit Tab/Enter choice. `forWhich`/`resume` let Escape during
  // the entity choice restore exactly the interaction state that existed
  // before this click, per "Escape cancels only the pending candidate
  // choice."
  function dxfMeasureResolveEntityClick(session, world, forWhich, resume, altBypass, onResolved) {
    const hits = dxfMeasureSnapEntityHitsForClick(session, world, altBypass);
    if (!hits.length) {
      showToast(forWhich === 'a'
        ? 'Click on the imported DXF pattern to place point A.'
        : 'Click on the same pattern piece to place point B.');
      return;
    }
    if (hits.length === 1) { onResolved(dxfMeasureRefFromHit(hits[0])); return; }
    session.interaction = { type: 'choosing-entity', forWhich, hits, chosenIndex: 0, resume, onResolved };
    showToast(hits.length + ' overlapping entities near that point — Tab to cycle, Enter to choose, Escape to cancel.');
    updateUI();
    requestRender();
  }

  function dxfMeasureBeginPlacement(session, world, altKey) {
    if (session.pendingMode === 'out-of-path') {
      const endpoint = dxfMeasureOutOfPathEndpointFromBoard(session, world, altKey);
      if (!endpoint) { showToast('Click anywhere to place point A.'); return; }
      session.interaction = { type: 'awaiting-b', mode: 'out-of-path', a: endpoint };
      session.placementArmed = false;
      session.selectedMeasurementId = null;
      updateUI();
      requestRender();
      return;
    }
    dxfMeasureResolveEntityClick(session, world, 'a', null, altKey, (ref) => {
      session.interaction = { type: 'awaiting-b', mode: 'along-path', a: ref };
      session.placementArmed = false;
      session.selectedMeasurementId = null;
      updateUI();
      requestRender();
    });
  }

  function dxfMeasureCompletePlacement(session, world, altKey) {
    const pending = session.interaction;
    if (!pending || pending.type !== 'awaiting-b') return;
    if (pending.mode === 'out-of-path') {
      const endpointB = dxfMeasureOutOfPathEndpointFromBoard(session, world, altKey);
      const measurement = dxfMeasureCreateOutOfPathMeasurement(session, pending.a, endpointB);
      session.selectedMeasurementId = measurement ? measurement.id : null;
      session.interaction = null;
      updateUI();
      requestRender();
      return;
    }
    dxfMeasureResolveEntityClick(session, world, 'b', pending, altKey, (refB) => {
      dxfMeasureResolveAlongPathPair(session, pending.a, refB);
    });
  }

  // ---- Unified Tab/Shift+Tab cycle + Enter confirm ---------------------------
  // (drives BOTH 'choosing-entity' and 'choosing-route' — same keys, same
  // affordance, whichever interaction is currently pending.)

  function dxfMeasureCycleRouteCandidate(session, delta) {
    const pending = session.interaction;
    if (!pending || (pending.type !== 'choosing-route' && pending.type !== 'choosing-entity')) return false;
    const list = pending.type === 'choosing-route' ? pending.candidates : pending.hits;
    const n = list.length;
    pending.chosenIndex = ((pending.chosenIndex + delta) % n + n) % n;
    requestRender();
    return true;
  }

  function dxfMeasureConfirmRouteCandidate(session) {
    const pending = session.interaction;
    if (!pending) return false;
    if (pending.type === 'choosing-entity') {
      const hit = pending.hits[pending.chosenIndex];
      pending.onResolved(dxfMeasureRefFromHit(hit));
      return true;
    }
    if (pending.type === 'choosing-route') {
      if (pending.truncated) {
        showToast('Route search was incomplete. No measurement was committed.');
        session.interaction = null;
        requestRender();
        return true;
      }
      const chosen = pending.candidates[pending.chosenIndex];
      dxfMeasureFinishAlongPath(session, pending.a, pending.b, pending.routes[chosen.routeIndex],
        chosen.direction, chosen.routeIndex, pending.routes.length);
      return true;
    }
    return false;
  }

  // ---- Endpoint / label drag --------------------------------------------------

  function dxfMeasureStartHandleDrag(session, hit, world) {
    session.interaction = {
      type: 'drag-endpoint', measurementId: hit.measurementId, which: hit.which, armed: false,
      startWorld: { x: world.x, y: world.y }, beforeFingerprint: dxfMeasureFingerprint(dxfMeasureSnapshot(session)),
      pendingWorld: null, preview: null,
    };
    session.selectedMeasurementId = hit.measurementId;
  }

  function dxfMeasureStartLabelDrag(session, hit, world) {
    const measurement = dxfMeasureGetMeasurement(session, hit.measurementId);
    if (!measurement) return;
    const anchor = dxfMeasureLabelAnchorWorldPos(session, measurement);
    const current = dxfMeasureLabelWorldPos(session, measurement);
    session.interaction = {
      type: 'drag-label', measurementId: hit.measurementId, armed: false,
      startWorld: { x: world.x, y: world.y },
      anchorAtStart: anchor, offsetAtStart: current && anchor ? { x: current.x - anchor.x, y: current.y - anchor.y } : { x: 0, y: 0 },
      labelOffsetAtStart: measurement.labelOffset ? clone(measurement.labelOffset) : null,
      beforeFingerprint: dxfMeasureFingerprint(dxfMeasureSnapshot(session)),
    };
    session.selectedMeasurementId = hit.measurementId;
  }

  function dxfMeasureDragArmed(interaction, world) {
    if (interaction.armed) return true;
    if (Math.hypot((world.x - interaction.startWorld.x) * state.zoom, (world.y - interaction.startWorld.y) * state.zoom) <= 3) return false;
    interaction.armed = true;
    return true;
  }

  // RB-3: mousemove NEVER mutates `measurement` and never re-projects/re-
  // enumerates synchronously — it only records the latest raw pointer
  // position (`pendingWorld`) and asks for a redraw. The actual (expensive)
  // projection + route enumeration happens in dxfMeasureRecomputeDragPreview,
  // called from the render layer at most once per animation frame (however
  // many raw mousemove events arrived since the last frame collapse into
  // that one recompute) — see render-dxf-measurements.js's drawDxfMeasurements.
  function dxfMeasureOnDragEndpointMove(session, world) {
    const interaction = session.interaction;
    if (!dxfMeasureDragArmed(interaction, world)) return;
    interaction.pendingWorld = { x: world.x, y: world.y };
    requestRender();
  }

  // Projects `interaction.pendingWorld` into a candidate new endpoint WITHOUT
  // touching the real measurement (RB-3's "project to a candidate endpoint
  // without mutating the measurement"), applying the SAME entity-ambiguity
  // rule as placement (RB-2) — a drag that hovers over more than one entity
  // does not silently pick one, it reports `ambiguous-entity` and keeps
  // showing the last COMMITTED geometry (via dxfMeasureDragInvalidFor) until
  // the TD moves to an unambiguous spot or releases to choose explicitly.
  function dxfMeasureRecomputeDragPreview(session, interaction) {
    if (!interaction.pendingWorld) return;
    if (session.diagnostics) session.diagnostics.dragPreviewRecomputes += 1;
    const world = interaction.pendingWorld;
    interaction.pendingWorld = null;
    const measurement = dxfMeasureGetMeasurement(session, interaction.measurementId);
    if (!measurement) { interaction.preview = { status: 'invalid' }; return; }
    if (measurement.mode === 'out-of-path') {
      const endpoint = dxfMeasureOutOfPathEndpointFromBoard(session, world);
      interaction.preview = endpoint ? { status: 'ok', endpoint } : { status: 'invalid' };
      return;
    }
    const hits = dxfMeasureHitTestNativeSegments(session, world, dxfMeasureToleranceWorld() * 4);
    const otherRef = interaction.which === 'a' ? measurement.b : measurement.a;
    const samePiece = hits.filter(h => h.pieceIndex === otherRef.pieceIndex);
    if (!samePiece.length) { interaction.preview = { status: 'invalid' }; return; }
    if (samePiece.length > 1) {
      interaction.preview = { status: 'ambiguous-entity', hits: samePiece };
      return;
    }
    const ref = dxfMeasureRefFromHit(samePiece[0]);
    const refA = interaction.which === 'a' ? ref : otherRef;
    const refB = interaction.which === 'a' ? otherRef : ref;
    const result = dxfMeasureEnumerateRoutes(session, refA, refB);
    if (result.reason === DXF_MEASURE_REASON.ROUTE_SEARCH_TRUNCATED || result.truncated) {
      interaction.preview = { status: 'truncated-route' };
      return;
    }
    if (!result.ok || !result.routes.length) { interaction.preview = { status: 'invalid' }; return; }
    if (result.routes.length > 1) {
      interaction.preview = { status: 'ambiguous-route', refA, refB, routes: result.routes, truncated: result.truncated };
      return;
    }
    interaction.preview = {
      status: 'ok', refA, refB, route: result.routes[0], routeCandidateIndex: 0, routeCandidateCount: 1, truncated: result.truncated,
    };
  }

  function dxfMeasureOnDragLabelMove(session, world) {
    const interaction = session.interaction;
    if (!dxfMeasureDragArmed(interaction, world)) return;
    const measurement = dxfMeasureGetMeasurement(session, interaction.measurementId);
    if (!measurement || !interaction.anchorAtStart) return;
    const dx = world.x - interaction.startWorld.x;
    const dy = world.y - interaction.startWorld.y;
    measurement.labelOffset = { x: interaction.offsetAtStart.x + dx, y: interaction.offsetAtStart.y + dy };
    requestRender();
  }

  // The single place an endpoint drag (or a drag's follow-up entity/route
  // choice) ever writes into the real measurement — everything upstream of
  // this only ever produced a fully-resolved (ref, route, direction) triple.
  // `direction` is optional/null: a plain unambiguous drag never changes it
  // (only the endpoint/route move); it is set only when the TD explicitly
  // picked a Forward/Reverse candidate out of a post-drag ambiguous-route
  // choice, so choosing "reverse" there actually flips the arrow.
  function dxfMeasureCommitDragEndpointFinal(session, measurementId, which, ref, route, routeCandidateIndex, routeCandidateCount, direction, beforeFingerprint) {
    const measurement = dxfMeasureGetMeasurement(session, measurementId);
    if (!measurement) { session.interaction = null; requestRender(); return; }
    dxfMeasureCommitEndpoint(session, measurement, which, ref, route, routeCandidateIndex, routeCandidateCount);
    if (direction) measurement.direction = direction;
    session.interaction = null;
    const after = dxfMeasureFingerprint(dxfMeasureSnapshot(session));
    if (beforeFingerprint !== after) dxfMeasurePushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  // Re-enumerates routes for a (refA, refB) pair produced by resolving a
  // mid-drag entity ambiguity (RB-2 applied to RB-3): if the now-explicit
  // entity still leaves several routes, this chains into the SAME
  // choosing-route machinery placement uses (via `commitInto`) rather than
  // silently taking routes[0] — a second layer of ambiguity does not get to
  // skip the same rule the first layer just enforced.
  // Only ever reached for an along-path measurement — an out-of-path drag's
  // preview never resolves to 'ambiguous-entity' in the first place (see
  // dxfMeasureRecomputeDragPreview: Out of Path has no entity concept at
  // all), so there is no out-of-path branch to write here.
  function dxfMeasureResolveDragEntityChoice(session, measurementId, which, ref, beforeFingerprint) {
    const measurement = dxfMeasureGetMeasurement(session, measurementId);
    if (!measurement) { session.interaction = null; requestRender(); return; }
    const otherRef = which === 'a' ? measurement.b : measurement.a;
    const refA = which === 'a' ? ref : otherRef;
    const refB = which === 'a' ? otherRef : ref;
    const result = dxfMeasureEnumerateRoutes(session, refA, refB);
    if (result.reason === DXF_MEASURE_REASON.ROUTE_SEARCH_TRUNCATED || result.truncated) {
      showToast('That endpoint creates too many routes to prove completely — drag canceled, the measurement is unchanged.');
      session.interaction = null;
      requestRender();
      return;
    }
    if (!result.ok || !result.routes.length) {
      showToast('That entity does not connect to point ' + (which === 'a' ? 'B' : 'A') + ' — drag canceled, the measurement is unchanged.');
      session.interaction = null;
      requestRender();
      return;
    }
    if (result.routes.length === 1) {
      dxfMeasureCommitDragEndpointFinal(session, measurementId, which, ref, result.routes[0], 0, 1, null, beforeFingerprint);
      return;
    }
    const piece = session.pieces[refA.pieceIndex];
    const candidates = dxfMeasureBuildDirectionCandidates(result.routes, piece && piece.segments);
    session.interaction = {
      type: 'choosing-route', mode: 'along-path', a: refA, b: refB,
      routes: result.routes, truncated: result.truncated, candidates,
      chosenIndex: dxfMeasurePreferredCandidateIndex(measurement, result.routes, candidates),
      commitInto: { measurementId, which, beforeFingerprint },
    };
    showToast(dxfMeasureRouteChoiceToast(result.routes.length, result.truncated));
    updateUI();
    requestRender();
  }

  // RB-3: the ONLY entry point where an endpoint drag can commit into the
  // real measurement (directly, or by handing off to the entity/route
  // chooser above). An armed-but-never-moved-to-anything-valid drag
  // (preview null/invalid) ends with NOTHING written — the measurement is
  // exactly as it was before the gesture started, satisfying "retain the
  // last valid committed endpoint, route, and numeric value." An ambiguous
  // release (entity or route) hands off to the SAME choosing-entity/
  // choosing-route machinery placement uses, with `resume: null` (there is
  // no earlier interaction to fall back to — Escape there simply abandons
  // the drag, leaving the pre-drag measurement untouched) and pushes
  // exactly one history entry once the TD confirms.
  function dxfMeasureFinishDrag(session) {
    const interaction = session.interaction;
    if (!interaction) return;
    dxfMeasureRecomputeDragPreview(session, interaction); // flush any move since the last render tick
    const preview = interaction.preview;
    if (!preview || preview.status === 'invalid') {
      session.interaction = null;
      requestRender();
      return;
    }
    if (preview.status === 'ambiguous-entity') {
      session.interaction = {
        type: 'choosing-entity', forWhich: interaction.which, hits: preview.hits, chosenIndex: 0, resume: null,
        onResolved: (ref) => dxfMeasureResolveDragEntityChoice(session, interaction.measurementId, interaction.which, ref, interaction.beforeFingerprint),
      };
      showToast(preview.hits.length + ' overlapping entities near that point — Tab to cycle, Enter to choose, Escape to cancel.');
      updateUI();
      requestRender();
      return;
    }
    if (preview.status === 'ambiguous-route') {
      const measurement = dxfMeasureGetMeasurement(session, interaction.measurementId);
      const piece = session.pieces[preview.refA.pieceIndex];
      const candidates = dxfMeasureBuildDirectionCandidates(preview.routes, piece && piece.segments);
      session.interaction = {
        type: 'choosing-route', mode: 'along-path', a: preview.refA, b: preview.refB,
        routes: preview.routes, truncated: preview.truncated, candidates,
        chosenIndex: dxfMeasurePreferredCandidateIndex(measurement, preview.routes, candidates),
        // Route confirm normally calls dxfMeasureFinishAlongPath (creates a
        // NEW measurement); a drag-originated route choice must instead
        // commit into the EXISTING measurement being dragged.
        commitInto: { measurementId: interaction.measurementId, which: interaction.which, beforeFingerprint: interaction.beforeFingerprint },
      };
      showToast(dxfMeasureRouteChoiceToast(preview.routes.length, preview.truncated));
      updateUI();
      requestRender();
      return;
    }
    // Unambiguous — commit immediately, exactly once, direction unchanged.
    const measurement = dxfMeasureGetMeasurement(session, interaction.measurementId);
    if (!measurement) { session.interaction = null; requestRender(); return; }
    const ref = measurement.mode === 'out-of-path'
      ? preview.endpoint
      : (interaction.which === 'a' ? preview.refA : preview.refB);
    dxfMeasureCommitDragEndpointFinal(session, interaction.measurementId, interaction.which, ref,
      preview.route || null, preview.routeCandidateIndex || 0, preview.routeCandidateCount || 1, null, interaction.beforeFingerprint);
  }

  function dxfMeasureFinishLabelDrag(session) {
    const interaction = session.interaction;
    session.interaction = null;
    if (!interaction) return;
    const after = dxfMeasureFingerprint(dxfMeasureSnapshot(session));
    if (interaction.beforeFingerprint !== after) dxfMeasurePushHistoryIfChanged();
    requestRender();
  }

  // ---- Public entry points (called from pointer-events.js) -------------------

  function dxfMeasureIsActiveTool() {
    return state.tool === 'pattern-measure' && dxfMeasureIsSessionActive();
  }

  function dxfMeasureOnMouseDown(world, altKey) {
    const session = state.dxfMeasureSession;
    if (!session) return;
    const tol = dxfMeasureToleranceWorld();
    if (session.interaction && (session.interaction.type === 'drag-endpoint' || session.interaction.type === 'drag-label')) {
      return; // stray press mid-drag; mouseup/next-down cannot happen without a mouseup first in practice
    }
    if (session.interaction && (session.interaction.type === 'choosing-route' || session.interaction.type === 'choosing-entity')) {
      return; // resolved by Tab/Enter/Escape only, per the toast shown when it opened
    }
    if (session.interaction && session.interaction.type === 'awaiting-b') {
      dxfMeasureCompletePlacement(session, world, altKey);
      return;
    }
    if (!session.interaction && session.placementArmed) {
      dxfMeasureBeginPlacement(session, world, altKey);
      return;
    }
    const handleHit = dxfMeasureHitTestHandle(session, world, tol);
    if (handleHit) { dxfMeasureStartHandleDrag(session, handleHit, world); return; }
    const labelHit = dxfMeasureHitTestLabel(session, world, tol);
    if (labelHit) { dxfMeasureStartLabelDrag(session, labelHit, world); return; }
    if (!session.interaction) {
      const routeHit = dxfMeasureHitTestRouteBody(session, world, tol);
      if (routeHit) {
        session.selectedMeasurementId = routeHit.measurementId;
        updateUI();
        requestRender();
        return;
      }
      dxfMeasureBeginPlacement(session, world, altKey);
      return;
    }
  }

  // US-112: records hover position/Alt state for the snap-preview marker
  // (drawDxfMeasureSnapHover) whenever idle or mid-placement (`awaiting-b`),
  // then falls through to the existing drag handlers unchanged. Recording
  // read-only position data and requesting a redraw is the same
  // record-now/compute-at-render-time split RB-3 already uses for drag
  // previews — this never touches `measurement`/`interaction` state itself.
  function dxfMeasureOnMouseMove(world, altKey) {
    const session = state.dxfMeasureSession;
    if (!session) return;
    session.hoverWorld = world;
    session.hoverAltKey = !!altKey;
    if (!session.interaction || session.interaction.type === 'awaiting-b') { requestRender(); return; }
    if (session.interaction.type === 'drag-endpoint') dxfMeasureOnDragEndpointMove(session, world);
    else if (session.interaction.type === 'drag-label') dxfMeasureOnDragLabelMove(session, world);
  }

  function dxfMeasureOnMouseUp() {
    const session = state.dxfMeasureSession;
    if (!session || !session.interaction) return;
    if (session.interaction.type === 'drag-endpoint') dxfMeasureFinishDrag(session);
    else if (session.interaction.type === 'drag-label') dxfMeasureFinishLabelDrag(session);
  }

  // Escape cancels an in-progress placement/route-choice/entity-choice/drag
  // WITHOUT deleting any completed measurement. For 'choosing-entity' this
  // restores `resume` (whatever interaction existed before the ambiguous
  // click — null if it was for point A, the awaiting-b state if it was for
  // point B) rather than clearing everything, per "Escape cancels only the
  // pending candidate choice." A drag has nothing to revert (RB-3: nothing
  // was ever mutated), so it simply clears.
  function dxfMeasureCancelInteraction() {
    const session = state.dxfMeasureSession;
    if (!session || !session.interaction) return false;
    const interaction = session.interaction;
    if (interaction.type === 'drag-label') {
      const measurement = dxfMeasureGetMeasurement(session, interaction.measurementId);
      if (measurement) measurement.labelOffset = interaction.labelOffsetAtStart ? clone(interaction.labelOffsetAtStart) : null;
    }
    session.interaction = interaction.type === 'choosing-entity' ? (interaction.resume || null) : null;
    showToast('Measurement canceled.');
    updateUI();
    requestRender();
    return true;
  }

  function dxfMeasureDeleteSelected() {
    const session = state.dxfMeasureSession;
    if (!session || session.selectedMeasurementId == null) return false;
    const ok = dxfMeasureDeleteMeasurement(session, session.selectedMeasurementId);
    if (ok) { updateUI(); requestRender(); }
    return ok;
  }

  function dxfMeasureHandleTabKey(shiftHeld) {
    const session = state.dxfMeasureSession;
    if (!session) return false;
    const ok = dxfMeasureCycleRouteCandidate(session, shiftHeld ? -1 : 1);
    return ok;
  }

  // Shared by the Cmd+Z/Cmd+Shift+Z keyboard shortcut, the toolbar Undo/Redo
  // buttons (src/ui/bindings.js), and the Command Palette (board.template.
  // import-dxf's siblings, project.undo/project.redo in command-registry.js)
  // — every one of those three surfaces must route to the session's own mini
  // stack while Pattern Measure is active, or the visible Undo button would
  // silently undo board annotation state instead while a TD's actual last
  // action was a measurement edit the global stack cannot see at all.
  function dxfMeasureOrGlobalUndo() {
    if (dxfMeasureIsActiveTool()) {
      dxfMeasureUndo();
      updateUI();
      requestRender();
      return;
    }
    flushLineNudgeSession();
    void undo();
  }

  function dxfMeasureOrGlobalRedo() {
    if (dxfMeasureIsActiveTool()) {
      dxfMeasureRedo();
      updateUI();
      requestRender();
      return;
    }
    flushLineNudgeSession();
    void redo();
  }

  function dxfMeasureHandleEnterKey() {
    const session = state.dxfMeasureSession;
    if (!session) return false;
    const pending = session.interaction;
    if (pending && pending.type === 'choosing-route' && pending.commitInto) {
      const chosen = pending.candidates[pending.chosenIndex];
      const ref = pending.commitInto.which === 'a' ? pending.a : pending.b;
      dxfMeasureCommitDragEndpointFinal(session, pending.commitInto.measurementId, pending.commitInto.which, ref,
        pending.routes[chosen.routeIndex], chosen.routeIndex, pending.routes.length, chosen.direction, pending.commitInto.beforeFingerprint);
      return true;
    }
    const ok = dxfMeasureConfirmRouteCandidate(session);
    if (ok) updateUI();
    return ok;
  }
