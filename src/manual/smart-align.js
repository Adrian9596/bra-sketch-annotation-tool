// US-099: translation-only Smart Align for lines and Template groups.
// computeSmartIntersectionSnapForHandle is a separate, later addition: it
// snaps a SINGLE dragged straight-line endpoint onto the crossing point of
// two OTHER straight reference lines — the one gesture a TD actually uses to
// place a POM line's end at a seam junction. It deliberately shares this
// file's tolerance conventions and the same Smart Align on/off + Alt-bypass
// switch rather than inventing a second setting.
// Source part for app.js. Run `npm run build` after editing.

  function setSmartAlignEnabled(enabled, announce) {
    state.smartAlignEnabled = !!enabled;
    state.smartAlignGuides = [];
    if (announce !== false) showToast(state.smartAlignEnabled
      ? 'Smart Align on. Hold Alt/Option during a drag to bypass it.'
      : 'Smart Align off.');
    updateUI();
    requestRender();
    return state.smartAlignEnabled;
  }

  function toggleSmartAlign() {
    return setSmartAlignEnabled(!state.smartAlignEnabled, true);
  }

  function smartAlignKeyPoints(ann) {
    if (!ann || !ann.start || !ann.end) return [];
    const points = [clonePoint(ann.start), clonePoint(ann.end)];
    const polyline = getAnnotationPolyline(ann, ann.type === 'straight' ? 1 : 48);
    const length = polylineLength(polyline);
    if (length > 0) points.push(samplePolylineAt(polyline, length / 2).point);
    return points;
  }

  function smartAlignTranslated(point, dx, dy) {
    return { x: point.x + dx, y: point.y + dy };
  }

  function smartAlignAngleDelta(a, b) {
    const ax = a.end.x - a.start.x, ay = a.end.y - a.start.y;
    const bx = b.end.x - b.start.x, by = b.end.y - b.start.y;
    const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
    if (al <= 0.0001 || bl <= 0.0001) return Infinity;
    const dot = clamp(Math.abs((ax * bx + ay * by) / (al * bl)), -1, 1);
    return Math.acos(dot);
  }

  function smartAlignResult(dx, dy, guides) {
    return { dx, dy, guides: Array.isArray(guides) ? guides : [] };
  }

  // A segment can only contribute a crossing point within `limit` of `point`
  // if some point ON the segment is within `limit` of `point` — and every
  // such point lies inside the segment's own bounding box, so a segment
  // whose bbox (expanded by `limit`) misses `point` can be dropped before
  // the pairwise check below. Bbox is a cheap over-approximation (some
  // false positives, never a false negative), so this never changes the
  // result — only how many candidates reach the O(n^2) pass.
  function lineBoundsNearPoint(line, point, limit) {
    const minX = Math.min(line.start.x, line.end.x) - limit;
    const maxX = Math.max(line.start.x, line.end.x) + limit;
    if (point.x < minX || point.x > maxX) return false;
    const minY = Math.min(line.start.y, line.end.y) - limit;
    const maxY = Math.max(line.start.y, line.end.y) + limit;
    return point.y >= minY && point.y <= maxY;
  }

  // Nearest point, within `limit`, where two DIFFERENT straight lines in
  // `lines` actually cross (segment bounds, not their infinite extension —
  // see segmentIntersection). The pairwise check is O(n^2), so `lines` is
  // first narrowed to candidates whose bounding box reaches `point` — on a
  // real grading-nest DXF import a board can carry thousands of reference
  // lines, and squaring that directly (this used to run unfiltered) is the
  // difference between a snap check costing low-single-digit milliseconds
  // and one costing tens of seconds.
  function nearestLineIntersectionSnap(point, lines, limit) {
    const candidates = lines.filter(line => lineBoundsNearPoint(line, point, limit));
    let best = null;
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const a = candidates[i], b = candidates[j];
        const hit = segmentIntersection(a.start, a.end, b.start, b.end);
        if (!hit) continue;
        const dist = distance(point, hit);
        if (dist <= limit && (!best || dist < best.dist)) {
          best = { dist, point: hit, referenceIds: [a.id, b.id] };
        }
      }
    }
    return best;
  }

  function computeSmartAlignment(startAnnotations, movingIds, rawDx, rawDy, bypass) {
    const dx = Number(rawDx) || 0, dy = Number(rawDy) || 0;
    // US-102: Smart Align is Sketch-Focus-only — its own on/off preference
    // (state.smartAlignEnabled) still governs whether it fires WITHIN Sketch
    // Focus, but POM Focus must be a hard off regardless of that preference,
    // so returning to Sketch Focus later restores exactly what the TD chose.
    if (!state.smartAlignEnabled || !state.sketchMode || bypass) return smartAlignResult(dx, dy, []);
    const moving = (Array.isArray(startAnnotations) ? startAnnotations : []).filter(Boolean);
    if (!moving.length) return smartAlignResult(dx, dy, []);
    const movingSet = new Set(Array.isArray(movingIds) ? movingIds : []);
    const references = state.annotations.filter(ann => !movingSet.has(ann.id) && !isAnnHidden(ann.id));
    if (!references.length) return smartAlignResult(dx, dy, []);

    const z = Math.max(0.0001, state.zoom);
    const endpointLimit = 10 / z;
    const straightReferences = references.filter(reference => reference.type === 'straight');
    let bestEndpoint = null;
    for (const source of moving) {
      for (const movingPoint of [source.start, source.end]) {
        const proposed = smartAlignTranslated(movingPoint, dx, dy);
        for (const reference of references) {
          for (const referencePoint of [reference.start, reference.end]) {
            const dist = distance(proposed, referencePoint);
            if (dist <= endpointLimit && (!bestEndpoint || dist < bestEndpoint.dist)) {
              bestEndpoint = {
                dist,
                dx: dx + referencePoint.x - proposed.x,
                dy: dy + referencePoint.y - proposed.y,
                guide: { type: 'point', point: clonePoint(referencePoint), referenceId: reference.id },
              };
            }
          }
        }
        // Same tier, same tolerance: the crossing point of two OTHER
        // reference lines is exactly as valid a snap target as either
        // reference's own endpoint — closest candidate wins either way.
        const hit = nearestLineIntersectionSnap(proposed, straightReferences, endpointLimit);
        if (hit && (!bestEndpoint || hit.dist < bestEndpoint.dist)) {
          bestEndpoint = {
            dist: hit.dist,
            dx: dx + hit.point.x - proposed.x,
            dy: dy + hit.point.y - proposed.y,
            guide: { type: 'intersection', point: clonePoint(hit.point), referenceIds: hit.referenceIds },
          };
        }
      }
    }
    if (bestEndpoint) return smartAlignResult(bestEndpoint.dx, bestEndpoint.dy, [bestEndpoint.guide]);

    const axisLimit = 7 / z;
    const movingPoints = moving.flatMap(smartAlignKeyPoints).map(point => smartAlignTranslated(point, dx, dy));
    const referencePoints = references.flatMap(smartAlignKeyPoints);
    let bestX = null, bestY = null;
    for (const movingPoint of movingPoints) {
      for (const referencePoint of referencePoints) {
        const deltaX = referencePoint.x - movingPoint.x;
        const deltaY = referencePoint.y - movingPoint.y;
        if (Math.abs(deltaX) <= axisLimit && (!bestX || Math.abs(deltaX) < Math.abs(bestX.delta))) {
          bestX = { delta: deltaX, value: referencePoint.x };
        }
        if (Math.abs(deltaY) <= axisLimit && (!bestY || Math.abs(deltaY) < Math.abs(bestY.delta))) {
          bestY = { delta: deltaY, value: referencePoint.y };
        }
      }
    }
    if (bestX || bestY) {
      const guides = [];
      if (bestX) guides.push({ type: 'vertical', value: bestX.value });
      if (bestY) guides.push({ type: 'horizontal', value: bestY.value });
      return smartAlignResult(dx + (bestX ? bestX.delta : 0), dy + (bestY ? bestY.delta : 0), guides);
    }

    // A move cannot rotate a path. Collinear snapping therefore applies only
    // when two straight paths are already near-parallel and removes the small
    // perpendicular gap between their infinite centerlines.
    const collinearLimit = 8 / z;
    const angleLimit = 5 * Math.PI / 180;
    let bestLine = null;
    for (const source of moving) {
      if (source.type !== 'straight') continue;
      const sourceMid = smartAlignTranslated({
        x: (source.start.x + source.end.x) / 2,
        y: (source.start.y + source.end.y) / 2,
      }, dx, dy);
      for (const reference of references) {
        if (reference.type !== 'straight' || smartAlignAngleDelta(source, reference) > angleLimit) continue;
        const vx = reference.end.x - reference.start.x;
        const vy = reference.end.y - reference.start.y;
        const length = Math.hypot(vx, vy);
        if (length <= 0.0001) continue;
        const nx = -vy / length, ny = vx / length;
        const signed = (sourceMid.x - reference.start.x) * nx + (sourceMid.y - reference.start.y) * ny;
        const magnitude = Math.abs(signed);
        if (magnitude <= collinearLimit && (!bestLine || magnitude < bestLine.magnitude)) {
          bestLine = {
            magnitude,
            dx: dx - nx * signed,
            dy: dy - ny * signed,
            guide: { type: 'line', start: clonePoint(reference.start), end: clonePoint(reference.end), referenceId: reference.id },
          };
        }
      }
    }
    return bestLine
      ? smartAlignResult(bestLine.dx, bestLine.dy, [bestLine.guide])
      : smartAlignResult(dx, dy, []);
  }

  // Single-endpoint drag (drag-handle in pointer-events.js) gets NO snap
  // support otherwise — computeSmartAlignment above only ever fires for a
  // whole-annotation body drag. This is deliberately narrower than that
  // function: only a STRAIGHT line's own start/end (never a curve's anchors
  // or handles, never midPoint) and only intersection-with-other-lines, not
  // endpoint-to-endpoint — the latter would be a separate, unrequested
  // feature. Returns the point unchanged (guide: null) whenever Smart Align
  // is off, bypassed, or the part/type isn't eligible, so callers can apply
  // the result unconditionally.
  function computeSmartIntersectionSnapForHandle(ann, part, point, bypass) {
    // US-102: same hard POM-Focus-off rule as computeSmartAlignment above.
    if (!state.smartAlignEnabled || !state.sketchMode || bypass || !ann || ann.type !== 'straight'
        || (part !== 'start' && part !== 'end')) {
      return { point: clonePoint(point), guide: null };
    }
    const z = Math.max(0.0001, state.zoom);
    const limit = 10 / z;
    const references = state.annotations.filter(other => other.id !== ann.id
      && other.type === 'straight' && !isAnnHidden(other.id));
    const hit = nearestLineIntersectionSnap(point, references, limit);
    if (!hit) return { point: clonePoint(point), guide: null };
    return {
      point: clonePoint(hit.point),
      guide: { type: 'intersection', point: clonePoint(hit.point), referenceIds: hit.referenceIds },
    };
  }

  function restoreAnnotationMoveGeometry(ann, source) {
    if (!ann || !source) return;
    for (const key of ['start', 'end', 'label', 'midPoint', 'midHandleIn', 'midHandleOut', 'control1', 'control2']) {
      ann[key] = source[key] ? clonePoint(source[key]) : null;
    }
    ann.points = clone(source.points || []);
  }
