// Manual-mode canvas tool state machines: the eraser and the click-to-draw
// flow. Source part for app.js. Run `npm run build` after editing.
//
// Both are invoked from onMouseDown (pointer-events.js) and each owns one
// state.*Session field. handleDrawToolClick implements the
// click-twice-to-draw flow, including the extension-line detection that
// splits a near-collinear follow-up click into its own POM annotation.

  // ---- Add point (US-093 / ADR 0053) ----
  // Is the "Add point" tool legitimately available right now? Returns the
  // annotation it would act on, or null. US-093 / ADR 0053 code review,
  // 2026-08-21: this is the ONE predicate both the toolbar (ui-status.js) and
  // the click handler below go through, so the button can never be offered for
  // a line the gesture then refuses — or worse, accepted for one where the
  // undo is destructive.
  function canAddCurveAnchor() {
    if (state.selection.kind !== 'annotation') return null;
    const ann = getSelectedAnnotation();
    if (!ann || ann.type !== 'curved') return null;
    // A line hidden by the spec panel's review × Hide toggle is not DRAWN, and
    // getSelectedAnnotation() — unlike getSelectedAnnotationIds() — does not
    // filter it out. Inserting into it would push a history entry with no
    // visible change on the board, and it would contradict hitTestAnnotations
    // / hitTestAnyEndpoint / isPointNearAnnotation, which all skip hidden lines
    // precisely so a click in an empty region can never mean a line that is
    // not there.
    if (isAnnHidden(ann.id)) return null;
    // Single selection only, matching every other handle-level gesture. With a
    // multi-line selection the Backspace that undoes an insertion is NOT the
    // anchor-delete branch — deleteSelected (annotation-lifecycle.js) gates
    // that on getSelectedAnnotationIds().length <= 1, so control would fall
    // through to the GROUP delete: one stray anchor insert would remove EVERY
    // selected line and push their labels into state.deletedPomKeys, dropping
    // those rows from the exported workbook too.
    if (getSelectedAnnotationIds().length > 1) return null;
    return ann;
  }

  // A click while this tool is active inserts a new interior anchor into the
  // currently selected curve, at the nearest point ON its path — never at the
  // raw click pixel, so the curve's shape does not change at the instant of
  // insertion. A click that misses that curve, or that would land too close to
  // an endpoint or another anchor to leave the split's handles grabbable, is
  // refused with a toast; this tool never acts on any other line.
  function handleAddPointClick(world) {
    const ann = canAddCurveAnchor();
    if (!ann) return;
    const nearest = nearestPointOnCurve(ann, world);
    const tolerance = Math.max(8, getLineWidth(ann) / 2 + 6) / state.zoom;
    if (!nearest || nearest.distance > tolerance) {
      // US-093 / ADR 0053 code review, 2026-08-21: every other refused gesture
      // in this app toasts, and a silent no-op reads as a broken button.
      showToast('Click on the curve to add a point.');
      return;
    }
    // Refuse an insertion that would leave a bend handle too short to grab, or
    // stack a second anchor on an occupied spot. Handle clearance is MEASURED,
    // not inferred from the anchor's: previewCurveAnchorInsertion dry-runs the
    // subdivision and reports the shortest of the four handle-to-point distances
    // it would write — the outer handle left on each side plus the new anchor's
    // own two. Handles are the half worth protecting because they are what a
    // press must hit, and a collapsed one is unrecoverable: deleteCurveAnchorAt
    // leaves the outer handles as it found them, and dragging the endpoint
    // carries the collapsed one rigidly along. The anchor-spacing half stays
    // because the handle check measures only against the split segment's OWN
    // ends, so a path that loops back past a non-adjacent anchor could still
    // stack one on it.
    //
    // US-093 / ADR 0053 code review, 2026-08-21: the gate is half the accept
    // tolerance — 4 screen px at every line width up to 4 (the default is 2.5),
    // tracking the tolerance above that — and near an end it is the HANDLE span
    // that binds, not the anchor's clearance. The split puts the flanking handle
    // at p0 + t.(p1-p0) while the anchor lands near p0 + 3t.(p1-p0), so read as
    // anchor clearance the refused zone is roughly three times the gate: on
    // POM 9 / demo1 the nearest legal landing sits 15.53 screen px from the end
    // (t = 0.0625, handle span 5.11 px), measured live by
    // board-interaction-check 4h. Re-tune minSeparation expecting that 3:1.
    // Kept tight rather than loosened: an inert button is recoverable by zooming
    // in and the toast says so, a sub-pixel handle is not. A segment whose
    // flanking handle is ALREADY under 4 px is refused along its whole length —
    // subdivision can only shorten it further.
    const minSeparation = tolerance / 2;
    const preview = previewCurveAnchorInsertion(ann, nearest.segIndex, nearest.t);
    const taken = [ann.start, ann.end].concat((ann.points || []).map(pt => pt && pt.point));
    if (preview && (preview.minHandleSpan < minSeparation
        || taken.some(p => p && distance(preview.point, p) <= minSeparation))) {
      showToast('Too close to an existing point. Zoom in to place one here.');
      return;
    }
    const index = insertCurveAnchorAt(ann, nearest.segIndex, nearest.t);
    // US-093 / ADR 0053 code review, 2026-08-21: -1 means insertCurveAnchorAt
    // rejected the segment index and mutated no geometry. Bail before naming a
    // selection part, because 'point-1.point' does not match
    // CURVE_ANCHOR_PART_RE, so parseCurveAnchorPart returns null and every
    // handle drag, arrow-key nudge and readout falls back to reading
    // ann['point-1.point'] — undefined — leaving the toolbar showing a selected
    // part that nothing can address. nearestPointOnCurve cannot produce an
    // out-of-range index on any live path today; this branch is what stops that
    // from being an assumption the next caller inherits silently.
    if (index < 0) {
      showToast('Could not add a point there.');
      return;
    }
    state.selection.part = 'point' + index + '.point';
    if (!ann.labelManual) ann.label = computeDefaultLabelPosition(ann);
    if (isTDReviewDraft(ann)) markDraftTouchedByTD(ann);
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  // ---- Eraser ----
  // Strokes live in image-local pixel coordinates so they automatically follow
  // their parent image when it is moved or resized. Rendering clips to the
  // image rect so strokes never bleed onto the white canvas background.
  function beginEraseStroke(world) {
    const imageHit = hitTestImages(world);
    if (!imageHit) return;
    const image = getImageById(imageHit.id);
    if (!image || !image.img) return;
    const local = worldToImageLocal(image, world);
    // brushSize is user-facing world pixels; convert to image-local px so the
    // stroke visually keeps that width regardless of the image's natural
    // resolution, and also scales correctly if the image is resized later.
    const naturalW = image.img.naturalWidth || image.width;
    const localSize = state.brushSize * (naturalW / image.width);
    state.eraseSession = {
      imageId: image.id,
      size: localSize,
      points: [local],
    };
    updateUI();
    requestRender();
  }

  function appendErasePoint(world) {
    const session = state.eraseSession;
    if (!session) return;
    const image = getImageById(session.imageId);
    if (!image || !image.img) return;
    const local = worldToImageLocal(image, world);
    const last = session.points[session.points.length - 1];
    const dx = local.x - last.x;
    const dy = local.y - last.y;
    // 2px (image-local) threshold trims jitter without losing curve fidelity
    if (dx * dx + dy * dy < 4) return;
    session.points.push(local);
    requestRender();
  }

  function commitEraseStroke() {
    const session = state.eraseSession;
    state.eraseSession = null;
    if (!session || !session.points.length) {
      updateUI();
      requestRender();
      return;
    }
    state.eraseStrokes.push({
      id: state.idCounter++,
      imageId: session.imageId,
      size: session.size,
      points: session.points,
    });
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  function worldToImageLocal(image, world) {
    const naturalW = image.img.naturalWidth || image.width;
    const naturalH = image.img.naturalHeight || image.height;
    return {
      x: (world.x - image.x) * (naturalW / image.width),
      y: (world.y - image.y) * (naturalH / image.height),
    };
  }

  // Return the endpoint at the cursor's current radius, with its angle rounded
  // to the nearest 45-degree increment around `start`. Keeping radius stable
  // makes Shift an angle constraint, not an unexpected resize operation.
  function constrainStraightEndpoint(start, current) {
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.0001) return clonePoint(current);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / step) * step;
    return {
      x: start.x + Math.cos(angle) * length,
      y: start.y + Math.sin(angle) * length,
    };
  }

  // Mouse movement is the common preview path for straight, curved, and
  // extension sessions. Straight keeps the unconstrained cursor separately so
  // a Shift key press/release can recompute the preview without another move.
  function updateDrawSessionPreview(world, angleLocked) {
    const session = state.drawSession;
    if (!session) return;
    if (session.type === 'straight') {
      session.rawCurrent = clonePoint(world);
      session.angleLocked = !!angleLocked;
      session.current = session.angleLocked
        ? constrainStraightEndpoint(session.start, session.rawCurrent)
        : clonePoint(session.rawCurrent);
      return;
    }
    session.current = world;
  }

  function refreshStraightDrawAngleLock(angleLocked) {
    const session = state.drawSession;
    if (!session || session.type !== 'straight' || !session.rawCurrent) return;
    session.angleLocked = !!angleLocked;
    session.current = session.angleLocked
      ? constrainStraightEndpoint(session.start, session.rawCurrent)
      : clonePoint(session.rawCurrent);
    updateUI();
    requestRender();
  }

  function handleDrawToolClick(world, angleLocked) {
    // Extension follow-up: a straight line was just committed and the tool is
    // offering an optional collinear dashed extension. A click within the axis
    // snap zone commits it as its own annotation (separate seq number); a click
    // off-axis falls through and starts a fresh straight line at this point.
    if (state.drawSession && state.drawSession.type === 'extension-followup') {
      const proj = projectionOnAxis(world, state.drawSession.prevEnd, state.drawSession.prevDir);
      if (proj.qualifies) {
        const tip = {
          x: state.drawSession.prevEnd.x + state.drawSession.prevDir.x * proj.distance,
          y: state.drawSession.prevEnd.y + state.drawSession.prevDir.y * proj.distance,
        };
        const ann = createStraightAnnotation(
          state.drawSession.prevEnd,
          tip,
          'dashed',
          state.drawSession.color,
          'single',
          state.drawSession.lineWidth,
        );
        state.annotations.push(ann);
        state.selection = { kind: 'annotation', id: ann.id };
        // US-096 / ADR 0055: not a bare `state.nextSequence += 1` any more. A
        // POM number is a measurement identity, so a construction line (an
        // unlabelled zigzag/cover/bartack) spends none — see
        // consumePomSequenceFor in src/manual/annotation-factory.js. The other
        // two commit paths below call the same helper.
        consumePomSequenceFor(ann);
        state.drawSession = null;
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        return;
      }
      // Off-axis click — drop follow-up and treat as start of a new line.
      state.drawSession = null;
    }

    if (!state.drawSession) {
      state.drawSession = {
        type: state.tool,
        style: state.drawStyle,
        color: state.drawColor,
        arrowType: state.arrowType,
        lineWidth: state.lineWidth,
        start: world,
        current: clonePoint(world),
        rawCurrent: clonePoint(world),
        angleLocked: !!angleLocked,
      };
      updateUI();
      requestRender();
      return;
    }

    // Curved lines take THREE clicks: start, middle, end. The middle click
    // records the point the curve must pass through; the curve is committed on
    // the third click. (Straight lines stay two clicks.)
    if (state.drawSession.type === 'curved') {
      const sess = state.drawSession;
      if (sess.mid == null) {
        if (distance(sess.start, world) < (4 / state.zoom)) return;
        sess.mid = clonePoint(world);
        sess.current = clonePoint(world);
        updateUI();
        requestRender();
        return;
      }
      if (distance(sess.mid, world) < (4 / state.zoom)) return;
      const curveAnn = createCurvedAnnotation(sess.start, world, sess.style, sess.color, sess.arrowType, sess.lineWidth, sess.mid);
      state.annotations.push(curveAnn);
      state.selection = { kind: 'annotation', id: curveAnn.id };
      consumePomSequenceFor(curveAnn);
      state.drawSession = null;
      pushHistoryIfChanged();
      updateUI();
      requestRender();
      return;
    }

    const start = state.drawSession.start;
    const end = angleLocked
      ? constrainStraightEndpoint(state.drawSession.start, world)
      : world;
    const drawSettings = state.drawSession;
    if (distance(start, end) < (4 / state.zoom)) {
      return;
    }

    if (state.tool === 'straight') {
      const ann = createStraightAnnotation(start, end, drawSettings.style, drawSettings.color, drawSettings.arrowType, drawSettings.lineWidth);
      state.annotations.push(ann);
      state.selection = { kind: 'annotation', id: ann.id };
      consumePomSequenceFor(ann);

      // Stay armed for an optional collinear dashed extension. The next click
      // along the line's axis commits a separate annotation with its own seq;
      // a click off-axis (or Esc / tool change) drops this state and starts a
      // fresh line. Only armed for solid lines in measurement (POM) mode —
      // not when drawing stitch styles where dashed has a different meaning.
      if (!isStitchMode() && drawSettings.style === 'solid') {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.max(0.0001, Math.hypot(dx, dy));
        state.drawSession = {
          type: 'extension-followup',
          color: drawSettings.color,
          lineWidth: drawSettings.lineWidth,
          prevEnd: clonePoint(end),
          prevDir: { x: dx / len, y: dy / len },
          current: clonePoint(end),
        };
      } else {
        state.drawSession = null;
      }

      pushHistoryIfChanged();
      updateUI();
      requestRender();
      return;
    }
  }

  // Project `world` onto the axis defined by `origin` + `dir` (unit vector).
  // Returns the signed forward distance, the perpendicular distance, and a
  // boolean that's true iff the cursor is in the extension snap zone
  // (positive forward distance, perpendicular within tolerance).
  function projectionOnAxis(world, origin, dir) {
    const dx = world.x - origin.x;
    const dy = world.y - origin.y;
    const distance = dx * dir.x + dy * dir.y;
    const perpX = dx - distance * dir.x;
    const perpY = dy - distance * dir.y;
    const perp = Math.hypot(perpX, perpY);
    const minDist = 4 / state.zoom;
    const maxPerp = 30 / state.zoom;
    return { distance, perp, qualifies: distance > minDist && perp <= maxPerp };
  }
