// Manual-mode canvas tool state machines: the eraser and the click-to-draw
// flow. Source part for app.js. Run `npm run build` after editing.
//
// Both are invoked from onMouseDown (pointer-events.js) and each owns one
// state.*Session field. handleDrawToolClick implements the
// click-twice-to-draw flow, including the extension-line detection that
// splits a near-collinear follow-up click into its own POM annotation.

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

  function handleDrawToolClick(world) {
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
        state.nextSequence += 1;
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
        current: world,
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
      state.nextSequence += 1;
      state.drawSession = null;
      pushHistoryIfChanged();
      updateUI();
      requestRender();
      return;
    }

    const start = state.drawSession.start;
    const end = world;
    const drawSettings = state.drawSession;
    if (distance(start, end) < (4 / state.zoom)) {
      return;
    }

    if (state.tool === 'straight') {
      const ann = createStraightAnnotation(start, end, drawSettings.style, drawSettings.color, drawSettings.arrowType, drawSettings.lineWidth);
      state.annotations.push(ann);
      state.selection = { kind: 'annotation', id: ann.id };
      state.nextSequence += 1;

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
