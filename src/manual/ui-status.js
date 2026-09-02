// Manual mode UI status sync: updateUI() is the single largest DOM-sync
// surface in the app — nearly every mutation in the codebase ends by calling
// it, and it touches ~50+ el.* toolbar/status references. AUTO_STATUS_COPY,
// autoStepStates, and updateAutoModeUI are Auto-Mode-specific toolbar/status
// wiring, kept here only because updateUI() calls updateAutoModeUI().
// Sibling files: paste / drag-drop image import lives in
// src/manual/image-import.js; POM/annotation lookup helpers live in
// src/manual/annotation-lookup.js.
// Source part for app.js. Run `npm run build` after editing.

  // US-104 "Quick length readout": a read-only, non-persisted length for the
  // current selection, shown whenever every selected annotation is a Sketch
  // Element (a DXF import, a placed Template, or any hand-drawn Scratch Area
  // line) — never for ordinary POM lines, which already have their own
  // measured-value display in the spec panel. Sums lineLength() over the
  // WHOLE selection rather than requiring exactly one: a normal click on a
  // multi-line piece auto-expands to its whole templateGroupId, so gating on
  // "exactly one" could never fire from a normal click. Not gated by Sketch
  // Focus vs POM Focus — the geometry is already on the board regardless of
  // focus state, and this is read-only, not an authoring tool.
  //
  // Round-6 fix: this used to be plain text appended to the end of the
  // free-form Tool status sentence, which is `white-space:nowrap` +
  // `text-overflow:ellipsis` — the LAST thing appended is the first thing an
  // over-length sentence cuts off, so the one number a TD actually wants
  // could silently vanish behind "…". It is now a standalone pill rendered
  // as a flex sibling of that sentence (see updateUI's toolStatus assembly
  // below and the `.sketch-length-chip` / `#toolStatus` CSS in index.html),
  // never inside the truncated span, and never truncated itself.
  function sketchSelectionLengthReadout() {
    const anns = getSelectedAnnotations();
    if (!anns.length || !anns.every(ann => ann.purpose === 'sketch-element')) return '';
    const totalPx = anns.reduce((sum, ann) => sum + lineLength(ann), 0);
    if (!(totalPx > 0)) return '';
    const label = anns.length > 1 ? 'Total length' : 'Length';
    const value = state.calibration.unitsPerPx != null
      ? formatMeasure(totalPx * state.calibration.unitsPerPx) + ' ' + state.calibration.unit
      : Math.round(totalPx) + ' px (uncalibrated)';
    return '<span class="sketch-length-chip" title="Sum of the selected Sketch Element line length(s)">'
      + label + ': ' + value + '</span>';
  }

  function updateUI() {
    // US-093 / ADR 0053 code review, 2026-08-21: the Add-point fallback has to
    // run before the tool buttons below read state.tool. It used to sit past
    // those reads, so pressing Backspace twice on a curve anchor — the second
    // press deletes the whole line and clears the selection — painted
    // toolSelect inactive while marking the now-hidden toolAddPoint active,
    // leaving the segmented control with no visible tool until some later
    // updateUI(). Routing through setTool() instead of assigning state.tool
    // also restores the app's single tool-change funnel: the drawSession /
    // eraseSession reset and the body.tool-eraser class were both being
    // skipped here. Recursion is bounded at one extra pass — setTool('select')
    // can never take its Auto-Mode early return (that guard rejects only
    // tool !== 'select'), so it always lands state.tool = 'select' and calls
    // updateUI() once; on that pass this condition is false, and that pass has
    // already synced everything this frame would have, so returning is safe.
    const addPointAvailable = !!canAddCurveAnchor();
    if (state.tool === 'add-point' && !addPointAvailable) {
      setTool('select');
      return;
    }
    el.toolSelect.classList.toggle('active', state.tool === 'select');
    el.toolStraight.classList.toggle('active', state.tool === 'straight');
    el.toolCurved.classList.toggle('active', state.tool === 'curved');
    el.toolEraser.classList.toggle('active', state.tool === 'eraser');
    el.toolEraser.disabled = state.images.length === 0;
    // US-092: the Text tool has no image requirement — a note can be a title or
    // a general remark on an otherwise empty board.
    el.toolText.classList.toggle('active', state.tool === 'text');
    el.toolRectangle.classList.toggle('active', state.tool === 'rectangle');
    el.toolCircle.classList.toggle('active', state.tool === 'circle');
    el.toolHexagon.classList.toggle('active', state.tool === 'hexagon');
    if (el.smartAlignToggleBtn) {
      el.smartAlignToggleBtn.setAttribute('aria-checked', state.smartAlignEnabled ? 'true' : 'false');
      el.smartAlignToggleBtn.textContent = (state.smartAlignEnabled ? '✓ ' : '') + 'Smart Align';
    }
    // US-112: same checkbox-menuitem convention as Smart Align above.
    if (el.dxfMeasureSnapEndpointBtn) {
      el.dxfMeasureSnapEndpointBtn.setAttribute('aria-checked', state.dxfMeasureSnapEndpoint ? 'true' : 'false');
      el.dxfMeasureSnapEndpointBtn.textContent = (state.dxfMeasureSnapEndpoint ? '✓ ' : '') + 'Endpoints';
    }
    if (el.dxfMeasureSnapMidpointBtn) {
      el.dxfMeasureSnapMidpointBtn.setAttribute('aria-checked', state.dxfMeasureSnapMidpoint ? 'true' : 'false');
      el.dxfMeasureSnapMidpointBtn.textContent = (state.dxfMeasureSnapMidpoint ? '✓ ' : '') + 'Midpoints';
    }
    if (el.dxfMeasureSnapIntersectionBtn) {
      el.dxfMeasureSnapIntersectionBtn.setAttribute('aria-checked', state.dxfMeasureSnapIntersection ? 'true' : 'false');
      el.dxfMeasureSnapIntersectionBtn.textContent = (state.dxfMeasureSnapIntersection ? '✓ ' : '') + 'Intersections';
    }
    el.brushSizeChip.hidden = state.tool !== 'eraser';
    if (el.brushSizeInput && document.activeElement !== el.brushSizeInput) {
      el.brushSizeInput.value = String(state.brushSize);
    }
    if (el.styleIdInput && document.activeElement !== el.styleIdInput) {
      el.styleIdInput.value = state.styleId || '';
    }
    const annotationCount = state.annotations.length;
    const imageCount = state.images.length;
    const selectedAnnotation = getSelectedAnnotation();
    // Round 9: Set Scale must require exactly one segment (see setScaleFromSelection's
    // comment in bindings.js) — a fresh DXF import or a Shift-clicked/marquee
    // multi-select both leave getSelectedAnnotationIds() with more than one id
    // even though selectedAnnotation (the primary) is a single line.
    const scaleGroupSelected = getSelectedAnnotationIds().length > 1;
    const soloAnnotationSelected = !!selectedAnnotation && !scaleGroupSelected;
    const selectedImage = getSelectedImage();
    const selectedNote = getSelectedNote();
    const selectedNotch = getSelectedNotch();
    const selectedGraphic = getSelectedBoardGraphic();
    const noteContext = !!selectedNote || state.tool === 'text';
    el.lineStyleControl.hidden = state.tool === 'eraser' || noteContext;
    el.lineWidthChip.hidden = state.tool === 'eraser' || noteContext;
    // US-092: the note's size chip lives beside Line, gated on a note being
    // selected OR the Text tool being ready to place one — never both chips
    // hidden at once for a note, never both shown at once for a line.
    el.fontSizeChip.hidden = !(selectedNote || state.tool === 'text');
    if (el.noteStyleMenuWrap) el.noteStyleMenuWrap.hidden = !noteContext;
    // US-093 / ADR 0053: only reachable while a curved annotation is
    // selected — same conditional-visibility convention as fontSizeChip /
    // brushSizeChip above, no disabled/greyed state anywhere else in this
    // toolbar. addPointAvailable is computed at the top of this function
    // because the fallback that consumes it has to precede the tool-button
    // reads. US-093 / ADR 0053 code review, 2026-08-21: it now comes from
    // canAddCurveAnchor(), the shared predicate, which additionally rules out
    // a multi-line selection (where Backspace would delete the whole group
    // rather than one anchor) and a hidden line (which is not drawn at all).
    if (el.toolAddPoint) {
      el.toolAddPoint.hidden = !addPointAvailable;
      el.toolAddPoint.classList.toggle('active', state.tool === 'add-point');
    }
    const activeStyle = selectedAnnotation ? getLineStyle(selectedAnnotation) : state.drawStyle;
    const activeColor = selectedAnnotation ? normalizeColorKey(selectedAnnotation.color)
      : selectedGraphic ? normalizeColorKey(selectedGraphic.color) : state.drawColor;
    const activeArrowType = selectedAnnotation ? getArrowType(selectedAnnotation) : state.arrowType;
    const activeLineWidth = getActiveLineWidth();
    updateLineStyleControl(activeStyle);
    if (el.lineWidthInput && document.activeElement !== el.lineWidthInput) {
      el.lineWidthInput.value = formatLineWidth(activeLineWidth);
    }
    if (el.fontSizeInput && document.activeElement !== el.fontSizeInput) {
      el.fontSizeInput.value = formatNoteFontSize(getActiveNoteFontSize());
    }
    el.arrowDoubleBtn.classList.toggle('active', activeArrowType === 'double');
    el.arrowSingleBtn.classList.toggle('active', activeArrowType === 'single');
    el.arrowNoneBtn.classList.toggle('active', activeArrowType === 'none');
    el.colorRedBtn.classList.toggle('active', activeColor === 'red');
    el.colorBlueBtn.classList.toggle('active', activeColor === 'blue');
    el.colorBlackBtn.classList.toggle('active', activeColor === 'black');
    el.colorWhiteBtn.classList.toggle('active', activeColor === 'white');

    const activeNoteAppearance = selectedNote ? noteAppearanceOf(selectedNote)
      : normalizeNoteAppearance(state.noteAppearance);
    const activeNoteTextColor = selectedNote ? noteTextColorOf(selectedNote)
      : normalizeColorKey(state.noteTextColor || 'black');
    const activeNoteLeaderColor = selectedNote ? noteLeaderColorOf(selectedNote)
      : normalizeColorKey(state.noteLeaderColor || 'red');
    if (el.noteAppearanceTextOnlyBtn) {
      el.noteAppearanceTextOnlyBtn.classList.toggle('active', activeNoteAppearance === NOTE_APPEARANCE_TEXT_ONLY);
    }
    if (el.noteAppearanceBoxBtn) {
      el.noteAppearanceBoxBtn.classList.toggle('active', activeNoteAppearance === NOTE_APPEARANCE_BOX);
    }
    for (const button of el.noteTextColorBtns || []) {
      button.classList.toggle('active', button.dataset.color === activeNoteTextColor);
    }
    for (const button of el.noteLeaderColorBtns || []) {
      button.classList.toggle('active', button.dataset.color === activeNoteLeaderColor);
    }
    if (el.noteStyleMenuBtn) {
      el.noteStyleMenuBtn.textContent = activeNoteAppearance === NOTE_APPEARANCE_BOX
        ? 'Note: Box' : 'Note: Text only';
      el.noteStyleMenuBtn.title = 'Text ' + activeNoteTextColor
        + ', leader ' + activeNoteLeaderColor + '; choose Note appearance and colours';
    }

    el.stitchesBtn.disabled = false;
    el.arrowDoubleBtn.disabled = false;
    el.arrowSingleBtn.disabled = false;
    el.arrowNoneBtn.disabled = false;

    let toolText = '';
    let lengthChipHtml = '';
    if (state.tool === 'text') {
      toolText = 'Text – Click the board to write a note. New notes use the active Note appearance and colours. <span class="kbd">Enter</span> makes a new line; <span class="kbd">⌘/Ctrl</span>+<span class="kbd">Enter</span> or a click on the board finishes it.';
    } else if (state.tool === 'notch') {
      toolText = 'Notch – Click near a line to place a small perpendicular notch mark there. <span class="kbd">Esc</span> returns to Select.';
    } else if (state.tool === 'stamp') {
      const stamp = (typeof getActiveShapeStamp === 'function') ? getActiveShapeStamp() : null;
      toolText = stamp
        ? 'Shape – Drag on the board to place <strong>' + escapeHtml(stamp.name)
          + '</strong> at that size. <span class="kbd">Shift</span> keeps its proportions, '
          + '<span class="kbd">Esc</span> stops stamping.'
        : 'Shape – Pick a saved shape from <strong>Tools</strong> first.';
    } else if (state.tool === 'select') {
      if (selectedNote) {
        toolText = selectedNote.leaders && selectedNote.leaders.length
          ? 'Select – Drag the note, its right-edge width handle, or an arrow tip; double-click a tip to remove that arrow, double-click the text to edit it, <span class="kbd">⌫</span> deletes the note.'
          : 'Select – Drag the note to move it, drag the right-edge handle to change wrap width, drag <strong>+</strong> to add an arrow, double-click to edit the text, <span class="kbd">⌫</span> deletes it.';
      } else if (selectedNotch) {
        // v1 has no drag (ADR 0071) — delete and re-place is the only edit.
        toolText = 'Select – This notch has no drag yet; <span class="kbd">⌫</span> deletes it and place a new one where you meant.';
      } else if (selectedAnnotation) {
        // Mirrors the selectedGraphic branch below: state.templateGroupEditId
        // means dragging THIS line moves only it, not the whole piece — the
        // exact "move piece only moves one segment" confusion a TD hits with
        // no visible cue otherwise (the toast from entering this mode fades).
        toolText = (state.templateGroupEditId != null && state.templateGroupEditId === selectedAnnotation.templateGroupId)
          ? 'Editing one line of this piece – dragging moves just this line. Click another line in it to switch, or '
            + '<span class="kbd">Esc</span> to select the whole piece again.'
          : 'Select – Drag line, endpoints, curve shape handle, or label. Smart Align is '
            + (state.smartAlignEnabled ? 'on; hold <span class="kbd">Alt/Option</span> to bypass it. ' : 'off. ')
            + '<span class="kbd">Tab</span> picks a point, arrow keys nudge it (<span class="kbd">⇧</span> = 10 px).';
        lengthChipHtml = sketchSelectionLengthReadout();
      } else if (selectedGraphic) {
        toolText = state.graphicEdit
          ? 'Edit Path – Select and drag nodes, handles, or segments; Cut Path opens the active point.'
          : 'Select – Drag or resize the Board Graphic; press Enter or double-click its outline for Edit Path.';
      } else if (selectedImage) {
        toolText = 'Select – Drag the image to move it, drag a corner handle to resize, use wheel to zoom, or hold <span class="kbd">Space</span> to pan.';
      } else {
        toolText = 'Select – Click an image, line, or label to select. Use wheel to zoom, double-click to fit, or hold <span class="kbd">Space</span> to pan.';
      }
    } else if (state.tool === 'straight') {
      toolText = state.drawSession && state.drawSession.type === 'straight'
        ? (state.drawSession.angleLocked
            ? 'Straight Line – Angle locked in 45° steps; click second point to finish.'
            : 'Straight Line – Click second point to finish; hold <span class="kbd">Shift</span> to lock to 45° steps.')
        : (state.drawSession
            ? 'Straight Line – Click second point to finish.'
            : 'Straight Line – Click first point; hold <span class="kbd">Shift</span> to lock to 45° steps.');
    } else if (state.tool === 'curved') {
      toolText = !state.drawSession
        ? 'Curved Line – Click the start point.'
        : (state.drawSession.mid == null
            ? 'Curved Line – Click the middle point the curve passes through.'
            : 'Curved Line – Click the end point to finish.');
    } else if (state.tool === 'add-point') {
      toolText = 'Add Point – Click the selected curve to add a bend point there. <span class="kbd">Alt</span> while dragging a handle moves it alone.';
    } else if (['rectangle','circle','hexagon'].includes(state.tool)) {
      toolText = TOOL_MENU_LABELS[state.tool] + ' – Drag a bounding box. Shift locks ratio; Alt/Option draws from centre.';
    } else if (dxfMeasureIsActiveTool()) {
      const measureSession = state.dxfMeasureSession;
      const modeLabel = measureSession.pendingMode === 'out-of-path' ? 'Out of Path' : 'Along Path';
      const interaction = measureSession.interaction;
      if (interaction && interaction.type === 'awaiting-b') {
        toolText = 'Pattern Measure (' + modeLabel + ') – Click the second point to finish.';
      } else if (interaction && interaction.type === 'choosing-entity') {
        toolText = 'Pattern Measure – Multiple entities near your click. <span class="kbd">Tab</span> cycles, <span class="kbd">Enter</span> confirms.';
      } else if (interaction && interaction.type === 'choosing-route') {
        toolText = 'Pattern Measure – Choose a route/direction. <span class="kbd">Tab</span> cycles, <span class="kbd">Enter</span> confirms.';
      } else {
        toolText = 'Pattern Measure (' + modeLabel + ') – Click the first point on the pattern.';
      }
      // ADR 0073: the unit and where it came from ride along on every
      // Pattern Measure status line — a guessed unit must never be invisible
      // while the TD is actively reading measured numbers.
      const unitStatus = dxfMeasureUnitStatus(measureSession);
      if (unitStatus) toolText += ' · Units: ' + unitStatus.key + ' (' + unitStatus.provenance + ')';
      // US-111: the TD-confirmed second surface for seam-match delta (the
      // panel is the first) — canvas itself stays a compact label, no badge.
      const activePairId = dxfMeasureFindSeamPairId(measureSession, measureSession.selectedMeasurementId);
      if (activePairId != null) {
        const pair = dxfMeasureGetSeamPair(measureSession, activePairId);
        const delta = dxfMeasureSeamPairDelta(measureSession, pair);
        if (delta) {
          toolText += ' · Seam match: Δ' + (dxfMeasureFormatInches(Math.abs(delta.raw)) || '—')
            + ' (' + dxfMeasureSeamPairStatus(delta) + ')';
        }
      }
    } else {
      toolText = imageCount === 0
        ? 'Eraser – Paste or import an image first, then drag to paint white over unwanted lines.'
        : (state.eraseSession
            ? 'Eraser – Release to commit. <span class="kbd">[</span>/<span class="kbd">]</span> resize brush.'
            : 'Eraser – Drag on the image to paint white over unwanted lines. <span class="kbd">[</span>/<span class="kbd">]</span> resize brush.');
    }
    el.toolStatus.innerHTML = '<span class="tool-status-text"><strong>Tool:</strong> ' + toolText + '</span>' + lengthChipHtml;

    const modeTitle = isStitchMode()
      ? 'Stitch mode: callout numbers are hidden so the stitch styles read clearly.'
      : 'POM mode (Point of Measure): each callout is numbered and linked to the measurement table.';
    const modeTag = '<strong>Mode:</strong> <span class="mode-tag" title="' + modeTitle + '">' + (isStitchMode() ? 'Stitch' : 'POM') + '</span> &nbsp;•&nbsp; ';
    let boardHtml;
    if (imageCount > 0) {
      boardHtml = '<strong>Board:</strong> ' + imageCount + ' image' + (imageCount === 1 ? '' : 's') + ' • ' + annotationCount + ' line' + (annotationCount === 1 ? '' : 's');
      el.boardCard.classList.remove('no-image');
    } else {
      boardHtml = annotationCount > 0
        ? '<strong>Board:</strong> <span class="muted">No image loaded • Press <span class="kbd">Ctrl/Cmd + V</span> to paste</span> • ' + annotationCount + ' line' + (annotationCount === 1 ? '' : 's')
        : '<strong>Board:</strong> <span class="muted">No image loaded • Press <span class="kbd">Ctrl/Cmd + V</span> to paste</span>';
      el.boardCard.classList.add('no-image');
    }
    el.boardCard.classList.toggle('is-empty', imageCount === 0 && annotationCount === 0 && (state.graphics || []).length === 0 && (state.notes || []).length === 0);
    el.imageStatus.innerHTML = modeTag + boardHtml;

    el.countStatus.innerHTML = '<strong>Images:</strong> ' + imageCount + ' &nbsp;•&nbsp; <strong>Annotations:</strong> ' + annotationCount + ' &nbsp;•&nbsp; <strong>Graphics:</strong> ' + (state.graphics || []).length;
    el.deleteBtn.disabled = !(selectedAnnotation || selectedNote || selectedGraphic || (selectedImage && !selectedImage.locked));
    const lineActionsEnabled = state.appMode !== 'auto';
    el.copyLineBtn.disabled = !((selectedAnnotation || selectedGraphic) && lineActionsEnabled);
    el.reflectLineBtn.disabled = !(selectedAnnotation && lineActionsEnabled);
    el.pasteLineBtn.disabled = !((hasLineClipboard() || hasGraphicClipboard()) && lineActionsEnabled);
    el.saveProjectBtn.disabled = annotationCount === 0 && imageCount === 0 && (state.graphics || []).length === 0 && (state.notes || []).length === 0;
    el.clearBtn.disabled = annotationCount === 0;
    el.fitBtn.disabled = imageCount === 0;
    // Lock toggle reflects the selected image's state. Without a selection
    // the button is disabled (no image to lock); with one, the label flips
    // between "Lock" and "Unlock" and the icon swaps closed/open.
    el.lockImageBtn.disabled = !selectedImage;
    if (selectedImage) {
      const locked = !!selectedImage.locked;
      el.lockImageLabel.textContent = locked ? 'Unlock' : 'Lock';
      el.lockImageBtn.title = locked
        ? 'Unlock the selected image so it can be moved, resized, or deleted again'
        : 'Lock the selected image so it can\'t be moved, resized, or deleted accidentally';
      el.lockImageBtn.classList.toggle('active', locked);
      // Swap the lock icon glyph: closed (default) vs open (shows when locked).
      el.lockImageIco.innerHTML = locked
        ? '<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" />'
        : '<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />';
    } else {
      el.lockImageLabel.textContent = 'Lock';
      el.lockImageBtn.classList.remove('active');
    }
    // US-105: while Pattern Measure is active, Undo/Redo act on its own mini
    // stack (dxfMeasureOrGlobalUndo/Redo) — the button's enabled state must
    // agree, or a TD could see "Undo" greyed out while a measurement edit is
    // genuinely undoable (or vice versa).
    if (dxfMeasureIsActiveTool()) {
      const measureHistory = state.dxfMeasureSession.history;
      el.undoBtn.disabled = measureHistory.past.length <= 1;
      el.redoBtn.disabled = measureHistory.future.length === 0;
    } else {
      el.undoBtn.disabled = state.history.past.length <= 1;
      el.redoBtn.disabled = state.history.future.length === 0;
    }
    const scaleBtnTitle = scaleGroupSelected
      ? 'Multiple segments selected — double-click one segment to select it alone, then Set Scale.'
      : 'Calibrate from a selected line whose real length you know';
    el.setScaleBtn.disabled = !soloAnnotationSelected;
    el.setScaleBtn.classList.toggle('active', state.calibration.unitsPerPx != null);
    el.setScaleBtn.title = scaleBtnTitle;
    el.clearScaleBtn.disabled = state.calibration.unitsPerPx == null;
    // Round 8: the Sketch-Focus-visible Set/Clear Scale pair mirrors the
    // same enabled/active state as the More-menu originals — same
    // calibration, just a second place to reach it.
    el.sketchSetScaleBtn.disabled = !soloAnnotationSelected;
    el.sketchSetScaleBtn.classList.toggle('active', state.calibration.unitsPerPx != null);
    el.sketchSetScaleBtn.title = scaleBtnTitle;
    el.sketchClearScaleBtn.disabled = state.calibration.unitsPerPx == null;
    // US-105: both entries need an active measure session; the title
    // explains why when there isn't one (matching the disabled-reason
    // convention every other conditionally-available control here uses).
    // .active reflects the CURRENTLY ARMED mode, not merely that the tool
    // is selected — so the two buttons behave like a two-way toggle, not two
    // independent switches.
    if (el.dxfMeasureAlongBtn) {
      const hasSession = !!state.dxfMeasureSession;
      el.dxfMeasureAlongBtn.disabled = !hasSession;
      el.dxfMeasureAlongBtn.title = hasSession ? 'Measure length along the imported pattern’s own path' : 'Import a DXF file first';
      el.dxfMeasureAlongBtn.classList.toggle('active', state.tool === 'pattern-measure'
        && hasSession && state.dxfMeasureSession.pendingMode === 'along-path');
    }
    if (el.dxfMeasureOutBtn) {
      const hasSession = !!state.dxfMeasureSession;
      el.dxfMeasureOutBtn.disabled = !hasSession;
      el.dxfMeasureOutBtn.title = hasSession ? 'Measure the direct straight-line distance between two points' : 'Import a DXF file first';
      el.dxfMeasureOutBtn.classList.toggle('active', state.tool === 'pattern-measure'
        && hasSession && state.dxfMeasureSession.pendingMode === 'out-of-path');
    }
    // US-113: same disabled-reason convention as Along/Out above.
    if (el.dxfMeasurementsListBtn) {
      const hasSession = !!state.dxfMeasureSession;
      el.dxfMeasurementsListBtn.disabled = !hasSession;
      el.dxfMeasurementsListBtn.title = hasSession ? 'List every measurement in this session' : 'Import a DXF file first';
      el.dxfMeasurementsListBtn.classList.toggle('active', isDxfMeasurementsPanelOpen());
    }
    if (typeof renderDxfMeasurementsPanel === 'function') renderDxfMeasurementsPanel();
    // US-114: the active-size filter — hidden entirely unless the current
    // import actually carries 2+ distinct size labels.
    if (typeof renderDxfMeasureSizeSelect === 'function') renderDxfMeasureSizeSelect();
    // ADR 0073: the native-unit select + provenance note. The select mirrors
    // the session's EFFECTIVE unit; the activeElement guard is the
    // brushSizeInput pattern above — never fight the TD mid-interaction.
    if (el.dxfMeasureUnitSelect) {
      const measureSession = state.dxfMeasureSession;
      const unitStatus = measureSession ? dxfMeasureUnitStatus(measureSession) : null;
      el.dxfMeasureUnitSelect.disabled = !measureSession;
      el.dxfMeasureUnitSelect.title = measureSession
        ? 'The unit the DXF file\'s own coordinates are in'
        : 'Import a DXF file first';
      if (measureSession && document.activeElement !== el.dxfMeasureUnitSelect) {
        // A file-declared ft/m/us-ft has no matching option; leave the
        // select showing its current value — the note names the real unit.
        if (['in', 'mm', 'cm'].includes(unitStatus.key)) el.dxfMeasureUnitSelect.value = unitStatus.key;
      }
      if (el.dxfMeasureUnitNote) {
        el.dxfMeasureUnitNote.textContent = unitStatus
          ? unitStatus.key + ' — ' + unitStatus.provenance
          : '';
      }
    }
    el.toggleLabelsBtn.textContent = state.showLabels ? 'Hide Numbers' : 'Show Numbers';
    el.toggleLabelsBtn.classList.toggle('active', !state.showLabels);
    // In Stitch mode numbers are hidden by the mode itself, so the manual
    // toggle has nothing to act on.
    el.toggleLabelsBtn.disabled = isStitchMode();

    updateAutoModeUI();
    updateBoardToolbarUI();
    renderSpecPanel();
    // US-038: keep the floating anchor panel in sync (fresh detect, mode
    // switch, canvas pin selection). renderAnchorManagerPanel auto-closes it
    // when we leave Auto Mode or lose anchors.
    if (isAnchorManagerOpen()) renderAnchorManagerPanel();
  }

  // U4: friendly copy for the raw auto.status machine states shown in the
  // toolbar chip. The raw value stays on dataset.status and in
  // state.autoMode.status (CSS hooks + __braAutoModeDebug.getState()), so
  // tests and styling are untouched — only the visible text is humanized.
  const AUTO_STATUS_COPY = {
    idle: 'Add a sketch to start',
    ready: 'Sketch ready — click Detect',
    loading: 'Loading…',
    detecting: 'Detecting sketch…',
    detected: 'Check the pins, then Generate',
    reviewing: 'Drafts waiting — review below',
    applying: 'Applying lines…',
    error: 'Needs attention',
  };

  // U4: which of the three pass steps is done / active for a given status.
  // 'active' means "this is your next step", so idle/ready point at Detect.
  function autoStepStates(status) {
    switch (status) {
      case 'detecting':
        return { detect: 'active', generate: 'todo', review: 'todo' };
      case 'detected':
        return { detect: 'done', generate: 'active', review: 'todo' };
      case 'reviewing':
      case 'applying':
      case 'error':
        return { detect: 'done', generate: 'done', review: 'active' };
      default: // idle / ready / loading
        return { detect: 'active', generate: 'todo', review: 'todo' };
    }
  }

  function updateAutoModeUI() {
    const isAuto = state.appMode === 'auto';
    // Mode switch buttons
    el.modeManualBtn.classList.toggle('active', !isAuto);
    el.modeAutoBtn.classList.toggle('active', isAuto);

    // Lock manual creation/edit tools while in Auto Mode.
    el.toolStraight.disabled = isAuto;
    el.toolCurved.disabled = isAuto;
    // US-092: notes are Manual-only to CREATE. They still RENDER in Auto (they
    // are board content, like applied lines) — this only closes the tool.
    el.toolText.disabled = isAuto;
    el.toolRectangle.disabled = isAuto;
    el.toolCircle.disabled = isAuto;
    el.toolHexagon.disabled = isAuto;
    if (isAuto) {
      el.toolEraser.disabled = true;
      // US-052: Delete in Auto Mode removes a selected PHOTO only (annotations/
      // drafts use Discard Drafts / Review-Only). Enable it when a non-locked
      // image is selected so an added photo can be removed without Reset Board.
      const selImg = getSelectedImage();
      el.deleteBtn.disabled = !(selImg && !selImg.locked);
      el.clearBtn.disabled = true;
    }

    if (!isAuto) {
      el.autoStatusChip.dataset.status = 'idle';
      el.autoStatusChip.textContent = AUTO_STATUS_COPY.idle;
      return;
    }

    const auto = state.autoMode;
    const draftCount = auto.draftAnnotations.length;
    const approvedCount = auto.draftAnnotations.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
    const hasSource = !!pickAutoSourceImage();

    el.autoStatusChip.dataset.status = auto.status;
    el.autoStatusChip.textContent = AUTO_STATUS_COPY[auto.status] || auto.status;
    el.autoStatusChip.title = auto.status === 'error' && auto.lastError
      ? auto.lastError
      : 'Auto Mode status';

    // U4: reflect the pass position in the Detect → Generate → Review steps.
    if (el.autoStepIndicator) {
      const stepStates = autoStepStates(auto.status);
      for (const stepEl of el.autoStepIndicator.children) {
        stepEl.dataset.state = stepStates[stepEl.dataset.step] || 'todo';
      }
    }

    // S1: vision-engine readiness chip (OpenCV WASM warm-up watcher).
    if (el.visionEngineChip) {
      const engine = state.visionEngine || 'warming';
      el.visionEngineChip.dataset.engine = engine;
      el.visionEngineChip.textContent =
        engine === 'ready' ? '✓ vision ready'
          : engine === 'warming' ? 'vision warming…'
            : 'basic vision';
      el.visionEngineChip.title =
        engine === 'ready'
          ? 'OpenCV vision engine compiled — Detect uses the highest-quality backend.'
          : engine === 'warming'
            ? 'The OpenCV vision engine is still compiling in the background. Keep working — Detect will use the best engine available when clicked.'
            : 'OpenCV engine unavailable — Detect uses the built-in fallback detector.';
    }

    // U5: reveal the Approve / Review-Only / Apply / Discard controls only
    // when they are actionable — a failed apply (status 'error') or drafts
    // lingering in the Auto layer (e.g. REVIEW_ONLY rows after returning
    // from Manual). The happy path auto-applies inside Generate and never
    // needs them.
    if (el.autoModeBar) {
      el.autoModeBar.classList.toggle('recovery', auto.status === 'error' || draftCount > 0);
    }

    const busy = auto.status === 'loading' || auto.status === 'applying' || auto.status === 'detecting';
    const hasAnchors = auto.anchors.length > 0;

    el.autoDetectBtn.disabled = busy;
    el.autoDetectBtn.title = hasSource
      ? 'Run local offline vision on the source sketch to estimate view, landmarks, and anchors'
      : 'No image on the board — add or select an image first, then click Detect Sketch';

    el.autoResetAnchorsBtn.disabled = busy || !auto.detection;
    el.autoResetAnchorsBtn.title = auto.detection
      ? 'Re-seed anchors from the current detection (discards manual anchor edits)'
      : 'Run Detect Sketch first';

    el.autoGenerateBtn.disabled = busy || !hasAnchors;
    el.autoGenerateBtn.title = hasAnchors
      ? 'Generate 18 POM drafts from the current anchor positions'
      : 'Detect Sketch + place anchors first';

    const selectedDraft = getSelectedDraft();
    el.autoApproveBtn.disabled = !selectedDraft || isReviewOnlyDraft(selectedDraft) || selectedDraft.tdApproved;
    el.autoReviewOnlyBtn.disabled = !selectedDraft || isReviewOnlyDraft(selectedDraft);
    el.autoApplyBtn.disabled = approvedCount === 0 || auto.status === 'applying';
    el.autoDiscardBtn.disabled = draftCount === 0;
    el.autoResetBoardBtn.disabled = busy || isWorkingBoardEmpty();

    // Learning loop controls: toggle reflects the persisted flag, chip
    // exposes the running sample count (the "measurable" property),
    // reset is only enabled when there is something to clear.
    const learningOn = isLearningEnabled();
    const learningSamples = getLearningSampleCount();
    el.autoLearnToggleBtn.classList.toggle('active', learningOn);
    el.autoLearnToggleBtn.title = learningOn
      ? 'Learning is ON — applies median calibration after Detect Sketch. Click to turn off.'
      : 'Learning is OFF — Detect Sketch uses pure geometric rules. Click to turn on.';
    el.autoLearnChip.textContent = learningSamples + ' sample' + (learningSamples === 1 ? '' : 's');
    el.autoLearnChip.dataset.status = learningOn && learningSamples >= 5 ? 'detected' : 'idle';
    if (el.learningToolbarBtn) {
      el.learningToolbarBtn.classList.toggle('active', learningOn);
      el.learningToolbarBtn.textContent = learningOn ? 'Learning On' : 'Learning Off';
      el.learningToolbarBtn.title = learningOn
        ? 'Learning is ON — click to view learning data. Correct Auto lines, then Save project + evidence.'
        : 'Click to turn learning on before correcting Auto lines.';
    }
    if (el.learningToolbarChip) {
      el.learningToolbarChip.textContent = learningSamples + ' sample' + (learningSamples === 1 ? '' : 's');
      el.learningToolbarChip.dataset.status = learningOn && learningSamples >= 5 ? 'detected' : 'idle';
      el.learningToolbarChip.title = learningOn
        ? 'Recorded TD correction samples used by learning.'
        : 'Learning is off. Click Learning Off to start collecting corrections.';
    }
    if (el.autoAcceptanceChip) {
      const acceptance = getAutoAcceptanceStats();
      const accepted = acceptance.acceptedWithoutEdit || 0;
      const total = acceptance.totalApplied || 0;
      const rate = total > 0 ? Math.round(accepted / total * 100) : 0;
      el.autoAcceptanceChip.textContent = accepted + '/' + total + ' accepted';
      el.autoAcceptanceChip.title = total > 0
        ? 'Auto-applied POM lines accepted without edit: ' + accepted + ' of ' + total + ' (' + rate + '%).'
        : 'No Auto-applied POM lines have been tracked yet.';
    }

    // Menu items reflect what is actually present.
    const styleId = currentStyleId();
    const currentMeaningCount = listConfirmedMeanings(styleId).length;
    let totalMeaningCount = 0;
    for (const sid of listKnownStyleIds()) {
      totalMeaningCount += listConfirmedMeanings(sid).length;
    }
    if (el.resetResidualsItem) {
      el.resetResidualsItem.disabled = learningSamples === 0;
      el.resetResidualsItem.textContent = 'Reset calibration residuals (' + learningSamples + ')';
    }
    if (el.resetMeaningsCurrentItem) {
      el.resetMeaningsCurrentItem.disabled = currentMeaningCount === 0;
      const styleLabel = styleId === '__default__' ? 'default bucket' : 'style "' + styleId + '"';
      el.resetMeaningsCurrentItem.textContent = 'Forget POM meanings — ' + styleLabel + ' (' + currentMeaningCount + ')';
    }
    if (el.resetMeaningsAllItem) {
      el.resetMeaningsAllItem.disabled = totalMeaningCount === 0;
      el.resetMeaningsAllItem.textContent = 'Forget POM meanings — all styles (' + totalMeaningCount + ')';
    }
    if (el.manageMeaningsItem) {
      el.manageMeaningsItem.disabled = currentMeaningCount === 0;
    }
  }
