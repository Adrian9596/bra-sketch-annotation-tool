// Manual mode UI status sync: updateUI() is the single largest DOM-sync
// surface in the app — nearly every mutation in the codebase ends by calling
// it, and it touches ~50+ el.* toolbar/status references. AUTO_STATUS_COPY,
// autoStepStates, and updateAutoModeUI are Auto-Mode-specific toolbar/status
// wiring, kept here only because updateUI() calls updateAutoModeUI().
// Sibling files: paste / drag-drop image import lives in
// src/manual/image-import.js; POM/annotation lookup helpers live in
// src/manual/annotation-lookup.js.
// Source part for app.js. Run `npm run build` after editing.

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
    el.lineStyleControl.hidden = state.tool === 'eraser';
    el.lineWidthChip.hidden = state.tool === 'eraser';
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
    const selectedImage = getSelectedImage();
    const selectedNote = getSelectedNote();
    // US-092: the note's size chip lives beside Line, gated on a note being
    // selected OR the Text tool being ready to place one — never both chips
    // hidden at once for a note, never both shown at once for a line.
    el.fontSizeChip.hidden = !(selectedNote || state.tool === 'text');
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
    // A selected note owns the swatch too — read from the note itself rather
    // than from state.drawColor, so an Undo that restores its old colour shows
    // up in the toolbar instead of leaving the stale draw default on display.
    const activeColor = selectedAnnotation ? normalizeColorKey(selectedAnnotation.color)
      : selectedNote ? normalizeColorKey(selectedNote.color)
        : state.drawColor;
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

    el.stitchesBtn.disabled = false;
    el.arrowDoubleBtn.disabled = false;
    el.arrowSingleBtn.disabled = false;
    el.arrowNoneBtn.disabled = false;

    let toolText = '';
    if (state.tool === 'text') {
      toolText = 'Text – Click the board to write a note. <span class="kbd">Enter</span> makes a new line; <span class="kbd">⌘/Ctrl</span>+<span class="kbd">Enter</span> or a click on the board finishes it.';
    } else if (state.tool === 'select') {
      if (selectedNote) {
        toolText = selectedNote.leaders && selectedNote.leaders.length
          ? 'Select – Drag the note or an arrow tip to move it, double-click a tip to remove that arrow, double-click the text to edit it, <span class="kbd">⌫</span> deletes the note.'
          : 'Select – Drag the note to move it, drag the <strong>+</strong> handle out to point an arrow at a detail, double-click to edit the text, <span class="kbd">⌫</span> deletes it.';
      } else if (selectedAnnotation) {
        toolText = 'Select – Drag line, endpoints, curve shape handle, or label. <span class="kbd">Tab</span> picks a point, arrow keys nudge it (<span class="kbd">⇧</span> = 10 px).';
      } else if (selectedImage) {
        toolText = 'Select – Drag the image to move it, drag a corner handle to resize, use wheel to zoom, or hold <span class="kbd">Space</span> to pan.';
      } else {
        toolText = 'Select – Click an image, line, or label to select. Use wheel to zoom, double-click to fit, or hold <span class="kbd">Space</span> to pan.';
      }
    } else if (state.tool === 'straight') {
      toolText = state.drawSession
        ? 'Straight Line – Click second point to finish.'
        : 'Straight Line – Click first point.';
    } else if (state.tool === 'curved') {
      toolText = !state.drawSession
        ? 'Curved Line – Click the start point.'
        : (state.drawSession.mid == null
            ? 'Curved Line – Click the middle point the curve passes through.'
            : 'Curved Line – Click the end point to finish.');
    } else if (state.tool === 'add-point') {
      toolText = 'Add Point – Click the selected curve to add a bend point there. <span class="kbd">Alt</span> while dragging a handle moves it alone.';
    } else {
      toolText = imageCount === 0
        ? 'Eraser – Paste or import an image first, then drag to paint white over unwanted lines.'
        : (state.eraseSession
            ? 'Eraser – Release to commit. <span class="kbd">[</span>/<span class="kbd">]</span> resize brush.'
            : 'Eraser – Drag on the image to paint white over unwanted lines. <span class="kbd">[</span>/<span class="kbd">]</span> resize brush.');
    }
    el.toolStatus.innerHTML = '<strong>Tool:</strong> ' + toolText;

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
    el.boardCard.classList.toggle('is-empty', imageCount === 0 && annotationCount === 0);
    el.imageStatus.innerHTML = modeTag + boardHtml;

    el.countStatus.innerHTML = '<strong>Images:</strong> ' + imageCount + ' &nbsp;•&nbsp; <strong>Annotations:</strong> ' + annotationCount;
    el.deleteBtn.disabled = !(selectedAnnotation || selectedNote || (selectedImage && !selectedImage.locked));
    const lineActionsEnabled = state.appMode !== 'auto';
    el.copyLineBtn.disabled = !(selectedAnnotation && lineActionsEnabled);
    el.reflectLineBtn.disabled = !(selectedAnnotation && lineActionsEnabled);
    el.pasteLineBtn.disabled = !(hasLineClipboard() && lineActionsEnabled);
    el.saveProjectBtn.disabled = annotationCount === 0 && imageCount === 0;
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
    el.undoBtn.disabled = state.history.past.length <= 1;
    el.redoBtn.disabled = state.history.future.length === 0;
    el.setScaleBtn.disabled = !selectedAnnotation;
    el.setScaleBtn.classList.toggle('active', state.calibration.unitsPerPx != null);
    el.clearScaleBtn.disabled = state.calibration.unitsPerPx == null;
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
