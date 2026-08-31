// Top-level UI bindings: bindUI() wires the toolbar, dropdowns, file
// inputs, the canvas, the label editor, and keyboard shortcuts. Tool and
// style setters live here next to the bindings that drive them, as do the
// two calibration commands (setScaleFromSelection / clearScale) their
// toolbar buttons invoke. The label editor the keydown/blur listeners point
// at is implemented in src/ui/label-editor.js.
// Source part for app.js. Run `npm run build` after editing.

  function bindUI() {
    initBoardToolbar();
    el.toolSelect.addEventListener('click', () => setTool('select'));
    el.toolStraight.addEventListener('click', () => setTool('straight'));
    el.toolCurved.addEventListener('click', () => setTool('curved'));
    el.toolEraser.addEventListener('click', () => setTool('eraser'));
    el.toolText.addEventListener('click', () => setTool('text'));
    el.toolRectangle.addEventListener('click', () => setTool('rectangle'));
    // ADR 0071.
    if (el.notchToolBtn) el.notchToolBtn.addEventListener('click', () => setTool('notch'));
    el.toolCircle.addEventListener('click', () => setTool('circle'));
    el.toolHexagon.addEventListener('click', () => setTool('hexagon'));
    if (el.smartAlignToggleBtn) el.smartAlignToggleBtn.addEventListener('click', toggleSmartAlign);
    if (el.sketchFocusBtn) el.sketchFocusBtn.addEventListener('click', () => toggleSketchMode());
    // US-093 / ADR 0053: only visible while a curved annotation is selected
    // (gated in updateUI, ui-status.js) — hidden buttons can't be clicked, so
    // no extra guard needed here.
    if (el.toolAddPoint) el.toolAddPoint.addEventListener('click', () => setTool('add-point'));

    el.stitchesBtn.addEventListener('click', toggleLineStyleMenu);
    // US-096: the preset dropdown owns its own rows and handlers.
    bindLinePresetPanel();
    bindShapeStampPanel();
    bindDxfImportPanel();
    bindPatternPiecesPanel();
    bindDxfMeasurePanel();
    el.styleOptionBtns.forEach((button) => {
      button.addEventListener('click', () => {
        setLineStyle(button.dataset.style);
        closeLineStyleMenu();
      });
    });

    el.lineWidthInput.addEventListener('input', () => {
      const n = parseFloat(el.lineWidthInput.value);
      if (Number.isFinite(n)) setLineWidth(n);
    });
    el.lineWidthInput.addEventListener('change', () => {
      el.lineWidthInput.value = formatLineWidth(getActiveLineWidth());
    });

    el.fontSizeInput.addEventListener('input', () => {
      const n = parseFloat(el.fontSizeInput.value);
      if (Number.isFinite(n)) setNoteFontSize(n);
    });
    el.fontSizeInput.addEventListener('change', () => {
      el.fontSizeInput.value = formatNoteFontSize(getActiveNoteFontSize());
    });
    if (el.noteAppearanceTextOnlyBtn) {
      el.noteAppearanceTextOnlyBtn.addEventListener('click', () => setNoteAppearance(NOTE_APPEARANCE_TEXT_ONLY));
    }
    if (el.noteAppearanceBoxBtn) {
      el.noteAppearanceBoxBtn.addEventListener('click', () => setNoteAppearance(NOTE_APPEARANCE_BOX));
    }
    for (const button of el.noteTextColorBtns || []) {
      button.addEventListener('click', () => setNoteTextColor(button.dataset.color));
    }
    for (const button of el.noteLeaderColorBtns || []) {
      button.addEventListener('click', () => setNoteLeaderColor(button.dataset.color));
    }

    el.brushSizeInput.addEventListener('input', () => {
      const n = parseInt(el.brushSizeInput.value, 10);
      if (Number.isFinite(n)) state.brushSize = clamp(n, 4, 200);
    });
    el.brushSizeInput.addEventListener('change', () => {
      el.brushSizeInput.value = String(state.brushSize);
    });

    el.arrowDoubleBtn.addEventListener('click', () => setArrowType('double'));
    el.arrowSingleBtn.addEventListener('click', () => setArrowType('single'));
    el.arrowNoneBtn.addEventListener('click', () => setArrowType('none'));

    el.colorRedBtn.addEventListener('click', () => setDrawColor('red'));
    el.colorBlueBtn.addEventListener('click', () => setDrawColor('blue'));
    el.colorBlackBtn.addEventListener('click', () => setDrawColor('black'));
    el.colorWhiteBtn.addEventListener('click', () => setDrawColor('white'));

    // US-105: routes to Pattern Measure's own mini undo stack while that
    // tool is active — see dxfMeasureOrGlobalUndo/Redo's own comment.
    el.undoBtn.addEventListener('click', () => dxfMeasureOrGlobalUndo());
    el.redoBtn.addEventListener('click', () => dxfMeasureOrGlobalRedo());
    el.copyLineBtn.addEventListener('click', copySelectedAnnotation);
    el.pasteLineBtn.addEventListener('click', pasteLineFromClipboard);
    el.reflectLineBtn.addEventListener('click', reflectSelectedAnnotation);
    el.deleteBtn.addEventListener('click', deleteSelected);
    el.editPathBtn.addEventListener('click', () => bgEnterEdit(getSelectedBoardGraphic()));
    el.cutPathBtn.addEventListener('click', cutSelectedBoardGraphicPath);
    el.segmentStraightBtn.addEventListener('click', () => bgSetActiveSegmentType('line'));
    el.segmentCurvedBtn.addEventListener('click', () => bgSetActiveSegmentType('curve'));
    el.clearBtn.addEventListener('click', clearAllAnnotations);
    el.lockImageBtn.addEventListener('click', toggleSelectedImageLock);
    el.fitBtn.addEventListener('click', fitSelectionOrAll);
    el.togglePanelBtn.addEventListener('click', toggleSpecPanel);
    // US-038: floating anchor manager (separate from the exported Measurements
    // panel). Toolbar toggles it; header/action buttons drive visibility.
    if (el.autoManageAnchorsBtn) el.autoManageAnchorsBtn.addEventListener('click', toggleAnchorManager);
    if (el.anchorManagerCloseBtn) el.anchorManagerCloseBtn.addEventListener('click', closeAnchorManager);
    if (el.anchorManagerHideAllBtn) el.anchorManagerHideAllBtn.addEventListener('click', () => { hideAllAnchors(); renderAnchorManagerPanel(); });
    if (el.anchorManagerShowAllBtn) el.anchorManagerShowAllBtn.addEventListener('click', () => { showAllAnchors(); renderAnchorManagerPanel(); });
    el.toggleLabelsBtn.addEventListener('click', toggleLabels);
    el.setScaleBtn.addEventListener('click', setScaleFromSelection);
    el.clearScaleBtn.addEventListener('click', clearScale);
    el.sketchSetScaleBtn.addEventListener('click', setScaleFromSelection);
    el.sketchClearScaleBtn.addEventListener('click', clearScale);
    el.sizeRunBtn.addEventListener('click', () => openSizeRunDialog());
    el.gradingBtn.addEventListener('click', () => openGradingDialog());
    el.exportPdfBtn.addEventListener('click', exportPdf);
    el.copyImageBtn.addEventListener('click', copyBoardImageToClipboard);
    el.exportExcelBtn.addEventListener('click', exportSpecXlsx);
    el.addImageBtn.addEventListener('click', () => el.imageFileInput.click());
    el.imageFileInput.addEventListener('change', onImageFileChosen);
    el.boardEmptyAdd.addEventListener('click', () => el.imageFileInput.click());
    el.importPptxBtn.addEventListener('click', () => el.pptxFileInput.click());
    el.pptxFileInput.addEventListener('change', onPptxFileChosen);
    if (el.boardEmptyImport) {
      el.boardEmptyImport.addEventListener('click', () => el.pptxFileInput.click());
    }
    el.helpBtn.addEventListener('click', openHelpDialog);

    el.modeManualBtn.addEventListener('click', () => requestAppModeChange('manual'));
    el.modeAutoBtn.addEventListener('click', () => requestAppModeChange('auto'));
    el.autoDetectBtn.addEventListener('click', () => {
      void runOfflineDetection();
    });
    el.autoResetAnchorsBtn.addEventListener('click', () => resetAnchorsToDetection());
    el.autoGenerateBtn.addEventListener('click', () => generatePOMDraftsFromAnchors());
    el.autoApproveBtn.addEventListener('click', () => {
      const draft = getSelectedDraft();
      if (!draft) { showToast('Select a draft row first.'); return; }
      blurActivePanelField();
      approveDraftAnnotation(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    el.autoReviewOnlyBtn.addEventListener('click', () => {
      const draft = getSelectedDraft();
      if (!draft) { showToast('Select a draft row first.'); return; }
      blurActivePanelField();
      markDraftReviewOnly(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    el.autoApplyBtn.addEventListener('click', () => applyApprovedDraftsAtomically());
    el.autoDiscardBtn.addEventListener('click', () => discardAutoDrafts());
    el.autoResetBoardBtn.addEventListener('click', () => resetWorkingBoard());
    el.autoLearnToggleBtn.addEventListener('click', () => setLearningEnabled(!isLearningEnabled()));
    if (el.learningToolbarBtn) {
      el.learningToolbarBtn.addEventListener('click', () => {
        if (!isLearningEnabled()) {
          setLearningEnabled(true);
          showToast('Learning is ON. Correct an Auto line, then Save project + evidence.');
          return;
        }
        openLearningDataDialog();
      });
    }
    if (el.autoLearnMenuBtn) {
      el.autoLearnMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAutoLearnMenu();
      });
    }
    if (el.viewLearningDataItem) {
      el.viewLearningDataItem.addEventListener('click', () => {
        closeAutoLearnMenu();
        openLearningDataDialog();
      });
    }
    if (el.resetResidualsItem) {
      el.resetResidualsItem.addEventListener('click', () => {
        closeAutoLearnMenu();
        resetLearning();
      });
    }
    if (el.resetMeaningsCurrentItem) {
      el.resetMeaningsCurrentItem.addEventListener('click', () => {
        closeAutoLearnMenu();
        resetPomMeanings('current');
      });
    }
    if (el.resetMeaningsAllItem) {
      el.resetMeaningsAllItem.addEventListener('click', () => {
        closeAutoLearnMenu();
        resetPomMeanings('all');
      });
    }
    if (el.styleIdInput) {
      el.styleIdInput.addEventListener('input', () => {
        state.styleId = el.styleIdInput.value.trim();
      });
      el.styleIdInput.addEventListener('change', () => {
        state.styleId = el.styleIdInput.value.trim();
        pushHistoryIfChanged();
        updateUI();
      });
    }

    setupDragAndDrop();
    el.saveProjectBtn.addEventListener('click', saveProject);
    el.openProjectBtn.addEventListener('click', () => el.projectFileInput.click());
    el.projectFileInput.addEventListener('change', onProjectFileChosen);
    if (el.libraryBtn) {
      el.libraryBtn.addEventListener('click', () => {
        closeBoardToolbarMenus(null, false);
        openLibraryManagerDialog();
      });
    }

    el.labelEditor.addEventListener('keydown', onLabelEditorKeyDown);
    el.labelEditor.addEventListener('blur', commitLabelEditor);

    // US-092. The blur commit covers every way focus can leave the note editor
    // EXCEPT a press on the board — that one is claimed by onMouseDown, which
    // runs before the focus change it causes (see note-editor.js).
    el.noteEditor.addEventListener('keydown', onNoteEditorKeyDown);
    el.noteEditor.addEventListener('input', onNoteEditorInput);
    el.noteEditor.addEventListener('blur', commitNoteEditor);

    el.canvas.addEventListener('mousedown', onMouseDown);
    el.canvas.addEventListener('dblclick', onDoubleClick);
    el.canvas.addEventListener('mousemove', onMouseMove);
    el.canvas.addEventListener('mouseleave', clearAnnotationHover);
    window.addEventListener('mouseup', onMouseUp);
    el.canvas.addEventListener('wheel', onWheel, { passive: false });
    // US-036: touch/pen layer — routes into the mouse handlers above; mouse
    // pointers are filtered out inside the handlers. Up/cancel bind on
    // window, mirroring the mouseup precedent, so a finger lifted
    // off-canvas still ends its drag.
    el.canvas.addEventListener('pointerdown', onTouchPointerDown, { passive: false });
    el.canvas.addEventListener('pointermove', onTouchPointerMove, { passive: false });
    window.addEventListener('pointerup', onTouchPointerEnd);
    window.addEventListener('pointercancel', onTouchPointerEnd);


    document.addEventListener('click', (e) => {
      if (!el.lineStyleControl.contains(e.target)) closeLineStyleMenu();
      if (el.autoLearnMenuWrap && !el.autoLearnMenuWrap.contains(e.target)) closeAutoLearnMenu();
      // US-038: click outside the floating anchor panel closes it — but not
      // when clicking the toolbar toggle (that has its own handler) or the
      // canvas (dragging pins while it's open should stay open).
      if (isAnchorManagerOpen()
          && !el.anchorManagerPanel.contains(e.target)
          && e.target !== el.autoManageAnchorsBtn
          && e.target !== el.canvas) {
        closeAnchorManager();
      }
      // ADR 0070: same click-outside-closes contract as the anchor panel
      // above — not the canvas, so selecting a piece via the board while the
      // panel is open stays possible.
      if (isPatternPiecesPanelOpen()
          && !el.patternPiecesPanel.contains(e.target)
          && e.target !== el.patternPiecesBtn
          && e.target !== el.canvas) {
        closePatternPiecesPanel();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isAnchorManagerOpen()) closeAnchorManager();
      if (e.key === 'Escape' && isPatternPiecesPanelOpen()) closePatternPiecesPanel();
    });
    document.addEventListener('paste', onPasteEvent);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', resizeCanvas);
  }

  function setTool(tool) {
    // In Auto Mode, only the select tool is allowed.
    if (state.appMode === 'auto' && tool !== 'select') {
      showToast('Switch back to Manual Mode to use the drawing tools.');
      return;
    }
    state.tool = tool;
    if (tool !== 'select') state.graphicEdit = null;
    // US-097: leaving the stamp tool disarms the chosen shape, so a later
    // press cannot place one the TD has stopped thinking about.
    if (tool !== 'stamp') setActiveShapeStamp(null);
    state.drawSession = null;
    state.eraseSession = null;
    if (tool === 'eraser') {
      state.selection = { kind: null, id: null };
    }
    document.body.classList.toggle('tool-eraser', tool === 'eraser');
    updateUI();
    requestRender();
  }


  // US-096 / ADR 0055: the two things this used to do at once are now separate.
  //
  // With lines selected, the TD is restyling THOSE lines. It changes the whole
  // selection (not just the primary, as before) and leaves state.drawStyle — and
  // therefore the board's POM/Stitch mode — alone. Previously converting one
  // line to zigzag hid every callout number on the board.
  //
  // With nothing selected, the TD is setting what the next line is born as, and
  // that still carries the board-mode switch and its toast, unchanged.
  function setLineStyle(style) {
    const normalized = normalizeLineStyle(style);
    if (getSelectedAnnotationsForEdit().length) {
      // Choosing an ordinary style is the explicit way to remove a Treatment
      // while preserving the source path. The layer recipe must not keep
      // painting invisibly after the toolbar says Plain/Dashed/Zigzag.
      applyToSelectedAnnotations({ style: normalized, lineTreatment: null });
      return;
    }
    setDefaultLineStyle(normalized);
  }

  function setDefaultLineStyle(normalized) {
    const wasStitchMode = isStitchMode();
    state.drawStyle = normalized;
    if (isStitchMode() !== wasStitchMode) {
      showToast(isStitchMode()
        ? 'Stitch mode — callout numbers hidden.'
        : 'POM mode — callout numbers shown.');
    }
    updateUI();
    requestRender();
  }

  function toggleLineStyleMenu(e) {
    e.stopPropagation();
    const isOpen = !el.stitchesMenu.hidden;
    if (isOpen) closeLineStyleMenu();
    else openLineStyleMenu();
  }

  function openLineStyleMenu() {
    if (el.stitchesBtn.disabled) return;
    el.stitchesMenu.hidden = false;
    el.stitchesBtn.setAttribute('aria-expanded', 'true');
  }

  function closeLineStyleMenu() {
    el.stitchesMenu.hidden = true;
    el.stitchesBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleAutoLearnMenu() {
    if (!el.autoLearnMenuList) return;
    if (!el.autoLearnMenuList.hidden) closeAutoLearnMenu();
    else openAutoLearnMenu();
  }

  function openAutoLearnMenu() {
    if (!el.autoLearnMenuList) return;
    el.autoLearnMenuList.hidden = false;
    el.autoLearnMenuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeAutoLearnMenu() {
    if (!el.autoLearnMenuList) return;
    el.autoLearnMenuList.hidden = true;
    if (el.autoLearnMenuBtn) el.autoLearnMenuBtn.setAttribute('aria-expanded', 'false');
  }

  function setArrowType(arrowType) {
    state.arrowType = arrowType;
    applyToSelectedAnnotation({ arrowType });
  }

  // Shift+A (board.arrow.cycle in command-registry.js) — the only keyboard
  // path to change arrow style; the three named arrow buttons stay
  // click/palette-only, same as every other per-value style picker (line
  // style, color). Cycles the SELECTED line's current arrow type when one is
  // selected, otherwise the pending default for the next drawn line — same
  // scope setArrowType already had.
  const ARROW_TYPE_CYCLE = ['none', 'single', 'double'];
  function cycleArrowType() {
    const selected = getSelectedAnnotation();
    const current = selected ? getArrowType(selected) : state.arrowType;
    const idx = ARROW_TYPE_CYCLE.indexOf(current);
    const next = ARROW_TYPE_CYCLE[idx >= 0 ? (idx + 1) % ARROW_TYPE_CYCLE.length : 0];
    setArrowType(next);
    showToast('Arrowheads: ' + (next === 'none' ? 'None' : next[0].toUpperCase() + next.slice(1)));
  }

  function setLineWidth(lineWidth) {
    const normalized = normalizeLineWidth(lineWidth);
    state.lineWidth = normalized;
    if (applyToSelectedBoardGraphic({ lineWidth: normalized })) return;
    applyToSelectedAnnotation({ lineWidth: normalized });
  }

  // A note's own size control (US-092), mirroring setLineWidth exactly — it
  // never touches applyToSelectedAnnotation, since a line and a note are never
  // selected at once (single-kind selection model).
  function setNoteFontSize(fontSize) {
    const normalized = normalizeNoteFontSize(fontSize);
    state.noteFontSize = normalized;
    applyFontSizeToSelectedNote(normalized);
  }

  function setDrawColor(color) {
    state.drawColor = color;
    if (applyToSelectedBoardGraphic({ color: normalizeColorKey(color) })) return;
    applyToSelectedAnnotation({ color });
  }

  function setNoteAppearance(appearance) {
    const next = normalizeNoteAppearance(appearance);
    state.noteAppearance = next;
    const note = getSelectedNote();
    if (note && noteAppearanceOf(note) !== next) {
      note.appearance = next;
      pushHistoryIfChanged();
    }
    updateUI();
    requestRender();
  }

  function setNoteTextColor(color) {
    const next = normalizeColorKey(color);
    state.noteTextColor = next;
    const note = getSelectedNote();
    if (note && noteTextColorOf(note) !== next) {
      note.textColor = next;
      // Keep the legacy alias synchronized for older consumers.
      note.color = next;
      pushHistoryIfChanged();
    }
    updateUI();
    requestRender();
  }

  function setNoteLeaderColor(color) {
    const next = normalizeColorKey(color);
    state.noteLeaderColor = next;
    const note = getSelectedNote();
    if (note && noteLeaderColorOf(note) !== next) {
      note.leaderColor = next;
      pushHistoryIfChanged();
    }
    updateUI();
    requestRender();
  }

  // Mutate the selected note's own fontSize directly and ride the generic
  // snapshot-diff into history exactly the way note appearance already does —
  // notes carry no per-object lineWidth/arrowType, so there is nothing else
  // here to fall through to.
  function applyFontSizeToSelectedNote(fontSize) {
    const note = getSelectedNote();
    if (!note) return false;
    const next = normalizeNoteFontSize(fontSize);
    if (note.fontSize !== next) {
      note.fontSize = next;
      pushHistoryIfChanged();
    }
    updateUI();
    requestRender();
    return true;
  }

  // US-096: applies to the WHOLE selection. Restyling eight Shift-clicked lines
  // used to take eight actions, because this only ever touched the primary.
  //
  // A style change can move a line in or out of the measurement set (ADR 0055),
  // so a line re-entering it may need a fresh POM number — see
  // reissuePomSequenceOnReentry.
  function applyToSelectedAnnotations(settings) {
    const anns = getSelectedAnnotationsForEdit();
    if (!anns.length) {
      updateUI();
      requestRender();
      return;
    }

    const before = snapshotFingerprint(makeSnapshot());
    for (const ann of anns) {
      const wasMeasurement = isMeasurementAnnotation(ann);
      Object.assign(ann, settings);
      if (!wasMeasurement && isMeasurementAnnotation(ann)) reissuePomSequenceOnReentry(ann);
    }
    const after = snapshotFingerprint(makeSnapshot());
    if (before !== after) pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  // Deliberately still the PRIMARY only. The colour swatch, arrow buttons and
  // line-width chip all read back from the primary in updateUI, so widening
  // them to the group is its own product decision, not a side effect of
  // US-096. Style and presets are the two things that go plural here.
  function applyToSelectedAnnotation(settings) {
    const ann = getSelectedAnnotation();
    if (!ann) {
      updateUI();
      requestRender();
      return;
    }

    const before = snapshotFingerprint(makeSnapshot());
    Object.assign(ann, settings);
    const after = snapshotFingerprint(makeSnapshot());
    if (before !== after) pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  function applyToSelectedBoardGraphic(settings) {
    const graphic = getSelectedBoardGraphic();
    if (!graphic) return false;
    Object.assign(graphic, settings);
    pushHistoryIfChanged(); updateUI(); requestRender(); return true;
  }

  // ---- Calibration ----
  // Round 9 (Codex follow-up on US-104): a DXF import lands as one selected
  // GROUP (every segment of every piece — dxf-import.js's importDxfText sets
  // state.selectedAnnotationIds to the whole batch), and a Template group
  // widens the same way on click. getSelectedAnnotation() only ever reads the
  // PRIMARY, so calibrating straight off a group silently used just its first
  // segment while every segment looked selected/highlighted — a TD had no way
  // to tell which line "10 in" actually meant. Requiring exactly one segment
  // in getSelectedAnnotationIds() (and pointing at the existing double-click
  // -> enterTemplateGroupForAnnotation gesture, viewport.js's onDoubleClick)
  // reuses the isolation mechanic the Template system already has, rather
  // than inventing a second one.
  function setScaleFromSelection() {
    if (getSelectedAnnotationIds().length > 1) {
      showToast('Multiple segments selected — double-click one segment to select it alone, then click Set Scale.');
      return;
    }
    const ann = getSelectedAnnotation();
    if (!ann) {
      showToast('Select a line first, then click Set Scale to calibrate by its real length.');
      return;
    }
    const px = lineLength(ann);
    if (px <= 0) {
      showToast('That line is too short to calibrate.');
      return;
    }
    openScaleDialog(px, null, ann.id);
  }

  function clearScale() {
    if (state.calibration.unitsPerPx == null) return;
    state.calibration = { unitsPerPx: null, unit: state.calibration.unit };
    pushHistoryIfChanged();
    showToast('Scale cleared. Values are now manual only.');
    updateUI();
    requestRender();
  }
