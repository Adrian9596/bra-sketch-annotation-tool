// US-099: translation-only Smart Align for lines and Template groups.
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

  function computeSmartAlignment(startAnnotations, movingIds, rawDx, rawDy, bypass) {
    const dx = Number(rawDx) || 0, dy = Number(rawDy) || 0;
    if (!state.smartAlignEnabled || bypass) return smartAlignResult(dx, dy, []);
    const moving = (Array.isArray(startAnnotations) ? startAnnotations : []).filter(Boolean);
    if (!moving.length) return smartAlignResult(dx, dy, []);
    const movingSet = new Set(Array.isArray(movingIds) ? movingIds : []);
    const references = state.annotations.filter(ann => !movingSet.has(ann.id) && !isAnnHidden(ann.id));
    if (!references.length) return smartAlignResult(dx, dy, []);

    const z = Math.max(0.0001, state.zoom);
    const endpointLimit = 10 / z;
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

  function restoreAnnotationMoveGeometry(ann, source) {
    if (!ann || !source) return;
    for (const key of ['start', 'end', 'label', 'midPoint', 'midHandleIn', 'midHandleOut', 'control1', 'control2']) {
      ann[key] = source[key] ? clonePoint(source[key]) : null;
    }
    ann.points = clone(source.points || []);
  }
