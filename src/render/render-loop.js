// Render scheduling + the main draw loop, and label editor positioning.
// Source part for app.js. Run `npm run build` after editing.
//
// requestRender batches into rAF so multiple state mutations in one tick
// turn into a single repaint. render() is the only place the canvas is
// transformed (pan + zoom) and walks every layer in z order: images,
// erase strokes, drafts (Auto Mode), committed annotations, selection
// helpers, detection overlay, anchors, label editor positioning.
//
// Pointer/viewport math (getMousePos, screenToWorld, getViewportRect,
// normalizeWheelDelta, zoomAtScreenPoint) and the double-click handler
// (onDoubleClick) live in the sibling viewport.js, which loads before
// this file.

function requestRender() {
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(() => {
      state.rafPending = false;
      render();
    });
  }

  // US-088: the last line of defence for "the buffer matches its CSS box".
  // A ResizeObserver covers box changes and a resolution media query covers
  // density changes, but both are event plumbing, and this invariant is too
  // expensive to get wrong — a mismatched buffer is stretched into the box, so
  // the board is painted at the wrong scale and every hit-test silently misses
  // by a margin that grows across the canvas. Checking it where the drawing
  // actually happens makes correctness independent of which event fired.
  //
  // Costs nothing per frame: it reads the cached rect rather than forcing
  // layout, and resizeCanvas' own early-return makes the common case a no-op.
  // It cannot loop — resizeCanvas fixes the buffer and requests one more frame,
  // and by that frame there is nothing left to fix.
  function syncCanvasBufferBeforeDraw() {
    const rect = state.lastCanvasRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (el.canvas.width === Math.round(rect.width * dpr)
      && el.canvas.height === Math.round(rect.height * dpr)) return;
    resizeCanvas();
  }

  function render() {
    syncCanvasBufferBeforeDraw();
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

    // US-092: text notes sit above every line body — a note is the TD's remark
    // ON the drawing — but BELOW the anchor layer, so a note can never hide an
    // anchor pin in Auto Mode (notes are not editable there; anchors are the
    // whole job). The POM number pass below still paints last, so a note never
    // covers a callout number either.
    // The note currently OPEN in the editor keeps its ARROWS but loses its box
    // and text: the textarea is sitting over that exact spot showing the live
    // text, and painting the committed text underneath it would show a stale
    // copy peeking out whenever the box grew — but the arrows are not chrome,
    // they say what the note points at, which is what the TD is looking at while
    // deciding what to write. Exports are unaffected either way; they draw from
    // exportNotes(), not from here.
    const editingNoteId = state.noteEditor && state.noteEditor.id != null ? state.noteEditor.id : null;
    for (const note of (state.notes || [])) {
      if (note.id === editingNoteId) drawNoteLeadersOnly(note);
      else drawNote(note);
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
    // A group of 2+ images gets ONE set of resize handles on its bounding box, so
    // dragging a corner scales the whole group about the opposite corner (photos
    // keep their relative sizes and spacing). Per-image handles stay off — they
    // would fight each other and give no group-relative anchor.
    if (selectedImages.length > 1) {
      const groupBox = getImagesGroupBox(selectedImages);
      if (groupBox && !selectedImages.some(im => im.locked)) {
        drawImageSelection(groupBox, true);
      }
    }

    // Line selection: a single selection shows full endpoint/handle helpers; a
    // multi-selection (Shift+click / marquee) shows a lighter per-line outline
    // on each member so the group reads as one.
    const selAnnIds = state.appMode !== 'auto' ? getSelectedAnnotationIds() : [];
    if (selAnnIds.length > 1) {
      for (const id of selAnnIds) {
        const a = getAnnotationById(id);
        if (a && !isAnnHidden(a.id)) drawAnnotationSelectedOutline(a);
      }
    } else {
      const selectedAnnotation = getSelectedAnnotation();
      if (selectedAnnotation && !isAnnHidden(selectedAnnotation.id)) {
        drawSelectionHelpers(selectedAnnotation);
      }
    }

    // US-092: the selected note's outline. Manual only — notes are not editable
    // in Auto Mode, so selection chrome there would advertise a gesture that
    // does nothing.
    //
    // Audit-found bug: also skipped for the note currently open in the editor —
    // same `editingNoteId` as the box+text suppression above, and for the same
    // reason, one layer late. drawNoteSelection derives the dashed rectangle and
    // both handle kinds from noteBounds(note), which reads note.text; typing in
    // the textarea never touches note.text (only commitNoteEditor does) and
    // never calls requestRender(), so this chrome would sit frozen at the
    // PRE-EDIT box while the textarea grows or shrinks under it — a stale
    // outline, and handles that end up floating detached (note shrank) or
    // buried under the textarea (note grew). It cannot be clicked either way:
    // any mousedown while the editor is open commits and returns before any
    // hit-test runs. Hiding it is simpler and more honest than trying to make
    // dashed-canvas-chrome track a live DOM textarea's measured size.
    if (state.appMode !== 'auto') {
      const selectedNote = getSelectedNote();
      if (selectedNote && selectedNote.id !== editingNoteId) drawNoteSelection(selectedNote);
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

    // Rubber-band selection rectangle (drawn last, over everything, in world
    // space so it tracks the sketch while zoomed/panned).
    if (state.interaction && state.interaction.type === 'marquee' && state.interaction.moved) {
      drawMarquee(state.interaction);
    }

    ctx.restore();
    positionLabelEditor();
    positionNoteEditor();
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
