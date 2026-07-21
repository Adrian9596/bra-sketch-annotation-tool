// Top-level UI bindings: bindUI() wires the toolbar, dropdowns, file
// inputs, the canvas, the label editor, and keyboard shortcuts. Tool and
// style setters live here next to the bindings that drive them.
// Source part for app.js. Run `npm run build` after editing.

  function bindUI() {
    el.toolSelect.addEventListener('click', () => setTool('select'));
    el.toolStraight.addEventListener('click', () => setTool('straight'));
    el.toolCurved.addEventListener('click', () => setTool('curved'));
    el.toolEraser.addEventListener('click', () => setTool('eraser'));

    el.stitchesBtn.addEventListener('click', toggleLineStyleMenu);
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

    el.undoBtn.addEventListener('click', () => void undo());
    el.redoBtn.addEventListener('click', () => void redo());
    el.copyLineBtn.addEventListener('click', copySelectedAnnotation);
    el.pasteLineBtn.addEventListener('click', pasteLineFromClipboard);
    el.reflectLineBtn.addEventListener('click', reflectSelectedAnnotation);
    el.deleteBtn.addEventListener('click', deleteSelected);
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
      el.libraryBtn.addEventListener('click', openLibraryDialog);
    }

    el.labelEditor.addEventListener('keydown', onLabelEditorKeyDown);
    el.labelEditor.addEventListener('blur', commitLabelEditor);

    el.canvas.addEventListener('mousedown', onMouseDown);
    el.canvas.addEventListener('dblclick', onDoubleClick);
    el.canvas.addEventListener('mousemove', onMouseMove);
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
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isAnchorManagerOpen()) closeAnchorManager();
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
    state.drawSession = null;
    state.eraseSession = null;
    if (tool === 'eraser') {
      state.selection = { kind: null, id: null };
    }
    document.body.classList.toggle('tool-eraser', tool === 'eraser');
    updateUI();
    requestRender();
  }


  function setLineStyle(style) {
    const normalized = normalizeLineStyle(style);
    const wasStitchMode = isStitchMode();
    state.drawStyle = normalized;
    if (isStitchMode() !== wasStitchMode) {
      showToast(isStitchMode()
        ? 'Stitch mode — callout numbers hidden.'
        : 'POM mode — callout numbers shown.');
    }
    applyToSelectedAnnotation({ style: normalized });
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

  function setLineWidth(lineWidth) {
    const normalized = normalizeLineWidth(lineWidth);
    state.lineWidth = normalized;
    applyToSelectedAnnotation({ lineWidth: normalized });
  }

  function setDrawColor(color) {
    state.drawColor = color;
    applyToSelectedAnnotation({ color });
  }

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

  function worldToScreen(x, y) {
    return { x: x * state.zoom + state.panX, y: y * state.zoom + state.panY };
  }

  // ---- Editable labels ----
  function openLabelEditor(id) {
    const ann = getAnnotationById(id);
    if (!ann) return;
    state.editingLabelId = id;
    const screen = worldToScreen(ann.label.x, ann.label.y);
    el.labelEditor.style.display = 'block';
    el.labelEditor.style.left = screen.x + 'px';
    el.labelEditor.style.top = screen.y + 'px';
    el.labelEditor.style.color = getAnnotationColor(ann);
    el.labelEditor.value = getLabelText(ann);
    requestRender();
    requestAnimationFrame(() => {
      el.labelEditor.focus();
      el.labelEditor.select();
    });
  }

  function onLabelEditorKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitLabelEditor();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelLabelEditor();
    }
    e.stopPropagation();
  }

  function commitLabelEditor() {
    const id = state.editingLabelId;
    if (id == null) return;
    const ann = getAnnotationById(id);
    state.editingLabelId = null;
    el.labelEditor.style.display = 'none';
    if (ann) {
      const raw = el.labelEditor.value.trim();
      const next = raw === '' ? null : raw;
      if (ann.text !== next) {
        ann.text = next;
        pushHistoryIfChanged();
      }
      // Phase 2/3 learning hook. POM 1–5 record silently. POM 6+ with
      // no confirmed meaning surface a one-click picker. Unknown labels
      // and re-commits without endpoint changes return 'skipped'.
      const evalResult = evaluateManualPomSample(ann);
      if (evalResult.status === 'recorded') {
        showToast('POM ' + ann.learnSamplePom + ' learning sample saved');
        updateUI();
      }
    }
    updateUI();
    requestRender();
  }

  function cancelLabelEditor() {
    state.editingLabelId = null;
    el.labelEditor.style.display = 'none';
    updateUI();
    requestRender();
  }
