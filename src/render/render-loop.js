// Render scheduling + the main draw loop, viewport math, and label
// editor positioning. Source part for app.js. Run `npm run build`
// after editing.
//
// requestRender batches into rAF so multiple state mutations in one tick
// turn into a single repaint. render() is the only place the canvas is
// transformed (pan + zoom) and walks every layer in z order: images,
// erase strokes, drafts (Auto Mode), committed annotations, selection
// helpers, detection overlay, anchors, label editor positioning.

  function getMousePos(e) {
    // Read the live rect for pointer input. Mode/toolbars can change the
    // canvas position without a window resize, and a stale cached rect makes
    // clicks land offset from the cursor.
    const rect = el.canvas.getBoundingClientRect();
    state.lastCanvasRect = rect;
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

function screenToWorld(x, y) {
  return {
    x: (x - state.panX) / state.zoom,
    y: (y - state.panY) / state.zoom
  };
}

function getViewportRect() {
  return state.lastCanvasRect || el.canvas.getBoundingClientRect();
}

function normalizeWheelDelta(e) {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * getViewportRect().height;
  return e.deltaY;
}

function zoomAtScreenPoint(nextZoom, screenX, screenY) {
  const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(clampedZoom - state.zoom) < 0.0001) return;
  const before = screenToWorld(screenX, screenY);
  state.zoom = clampedZoom;
  state.panX = screenX - before.x * state.zoom;
  state.panY = screenY - before.y * state.zoom;
  updateUI();
  requestRender();
}

function onDoubleClick(e) {
  if (state.tool !== 'select') return;
  const mouse = getMousePos(e);
  const world = screenToWorld(mouse.x, mouse.y);
  const annHit = hitTestAnnotations(world);
  if (annHit) {
    setSelection('annotation', annHit.id);
    openLabelEditor(annHit.id);
    return;
  }
  const imageHit = hitTestImages(world);
  if (imageHit) {
    setSelection('image', imageHit.id);
    const image = getImageById(imageHit.id);
    if (image) fitBoundsToViewport(getImageBounds(image));
    return;
  }
  fitSelectionOrAll();
}

function requestRender() {
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(() => {
      state.rafPending = false;
      render();
    });
  }

  function render() {
    const rect = state.lastCanvasRect || el.canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.zoom, state.zoom);

    for (const image of state.images) {
      drawImageItem(image);
    }

    for (const stroke of state.eraseStrokes) {
      drawEraseStroke(stroke);
    }
    if (state.eraseSession) {
      drawEraseStrokeSession(state.eraseSession);
    }

    // Auto Mode offline detection overlay — drawn below project annotations
    // so it never hides committed lines, but above the image so the TD can
    // sanity-check bbox / axis / band before generating POMs.
    //
    // Tie its visibility to `anchorsHidden`, the tuning-phase flag: the
    // scaffolding (view boxes, axis, band/cradle/chest guides, region
    // labels, sym badge) and the draggable anchors are one unit — both are
    // useful while tuning, both are pure clutter once the POM lines are
    // applied. They hide together after Generate and reappear together on
    // Reset Anchors.
    if (state.appMode === 'auto'
        && state.autoMode.detection
        && !state.autoMode.anchorsHidden) {
      drawDetectionOverlay(state.autoMode.detection);
    }

    for (const ann of state.annotations) {
      if (isAnnHidden(ann.id)) continue;
      drawAnnotation(ann, false); // line body only — numbers drawn in the label pass below
    }

    // Auto Mode draft layer — rendered above project annotations so reviewers
    // see the proposed lines clearly. Drafts do not enter state.annotations
    // until applyApprovedDraftsAtomically() commits them.
    if (state.appMode === 'auto') {
      for (const draft of state.autoMode.draftAnnotations) {
        if (isDraftHidden(draft.id)) continue;
        drawAutoDraftAnnotation(draft, false); // line body only — number drawn in the label pass below
      }
    }

    // Anchors render above drafts so they always stay grabbable.
    if (state.appMode === 'auto') {
      drawAnchors();
      drawAnchorLoupe();
    }

    // Label pass — POM numbers are drawn LAST, above every line body and the
    // anchor layer, so a line or anchor never covers a callout number (this was
    // the "line over the number" clutter on crowded 3-view boards). Draw order
    // only; hit-testing is separate, so anchors and lines stay grabbable.
    for (const ann of state.annotations) {
      if (isAnnHidden(ann.id)) continue;
      drawAnnotationLabel(ann);
    }
    if (state.appMode === 'auto') {
      for (const draft of state.autoMode.draftAnnotations) {
        if (isDraftHidden(draft.id)) continue;
        drawAutoDraftLabel(draft);
      }
    }

    if (state.drawSession) {
      drawPreview();
    }

    // Highlight every selected image. A single selection keeps its resize
    // handles; a Cmd/Ctrl+click group shows outlines only (move-together).
    const selectedImages = getSelectedImages();
    const showImageHandles = selectedImages.length <= 1;
    for (const selectedImage of selectedImages) {
      drawImageSelection(selectedImage, showImageHandles);
    }

    const selectedAnnotation = getSelectedAnnotation();
    if (selectedAnnotation && !isAnnHidden(selectedAnnotation.id)) {
      drawSelectionHelpers(selectedAnnotation);
    }

    if (state.appMode === 'auto') {
      const selectedDraft = getSelectedDraft();
      if (selectedDraft
          && !isReviewOnlyDraft(selectedDraft)
          && selectedDraft.start
          && !isDraftHidden(selectedDraft.id)) {
        drawSelectionHelpers(selectedDraft);
      }
    }

    // Live length readout while the user is dragging a line endpoint, so
    // they can size the line accurately without releasing to check the
    // measurement panel.
    drawLengthReadoutDuringHandleDrag();

    ctx.restore();
    positionLabelEditor();
  }

  function drawLengthReadoutDuringHandleDrag() {
    const inter = state.interaction;
    if (!inter || inter.type !== 'drag-handle') return;
    if (inter.part !== 'start' && inter.part !== 'end') return;
    const ann = getAnnotationById(inter.id);
    if (!ann || !ann.start || !ann.end) return;
    const lengthPx = lineLength(ann);
    let label;
    if (state.calibration.unitsPerPx != null) {
      label = formatMeasure(lengthPx * state.calibration.unitsPerPx) + ' ' + state.calibration.unit;
    } else {
      label = Math.round(lengthPx) + ' px';
    }
    const anchor = inter.part === 'start' ? ann.start : ann.end;
    const z = Math.max(state.zoom, 0.15);
    const padX = 6 / z, padY = 4 / z;
    ctx.save();
    ctx.font = '600 ' + (12 / z).toFixed(1) + 'px system-ui, sans-serif';
    const metrics = ctx.measureText(label);
    const boxW = metrics.width + padX * 2;
    const boxH = 16 / z + padY * 2;
    const bx = anchor.x + 12 / z;
    const by = anchor.y - boxH - 6 / z;
    ctx.fillStyle = 'rgba(17, 24, 39, 0.92)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 1 / z;
    const r = 5 / z;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + boxW - r, by);
    ctx.quadraticCurveTo(bx + boxW, by, bx + boxW, by + r);
    ctx.lineTo(bx + boxW, by + boxH - r);
    ctx.quadraticCurveTo(bx + boxW, by + boxH, bx + boxW - r, by + boxH);
    ctx.lineTo(bx + r, by + boxH);
    ctx.quadraticCurveTo(bx, by + boxH, bx, by + boxH - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + padX, by + boxH / 2);
    ctx.restore();
  }

  function positionLabelEditor() {
    if (state.editingLabelId == null) return;
    const ann = getAnnotationById(state.editingLabelId);
    if (!ann) { cancelLabelEditor(); return; }
    const screen = worldToScreen(ann.label.x, ann.label.y);
    el.labelEditor.style.left = screen.x + 'px';
    el.labelEditor.style.top = screen.y + 'px';
  }
