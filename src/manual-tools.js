// Manual annotation tools, import/save/open, measurement panel, history, selection, geometry helpers.
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
    el.deleteBtn.addEventListener('click', deleteSelected);
    el.clearBtn.addEventListener('click', clearAllAnnotations);
    el.lockImageBtn.addEventListener('click', toggleSelectedImageLock);
    el.fitBtn.addEventListener('click', fitSelectionOrAll);
    el.togglePanelBtn.addEventListener('click', toggleSpecPanel);
    el.toggleLabelsBtn.addEventListener('click', toggleLabels);
    el.setScaleBtn.addEventListener('click', setScaleFromSelection);
    el.clearScaleBtn.addEventListener('click', clearScale);
    el.exportPdfBtn.addEventListener('click', exportPdf);
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
    if (el.autoLearnMenuBtn) {
      el.autoLearnMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAutoLearnMenu();
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
    if (el.manageMeaningsItem) {
      el.manageMeaningsItem.addEventListener('click', () => {
        closeAutoLearnMenu();
        openManageMeaningsPicker();
      });
    }
    if (el.pmpSkipBtn)  el.pmpSkipBtn.addEventListener('click', () => closePomMeaningPopover());
    if (el.pmpOtherBtn) el.pmpOtherBtn.addEventListener('click', () => showPomMeaningOtherMode());
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

    el.labelEditor.addEventListener('keydown', onLabelEditorKeyDown);
    el.labelEditor.addEventListener('blur', commitLabelEditor);

    el.canvas.addEventListener('mousedown', onMouseDown);
    el.canvas.addEventListener('dblclick', onDoubleClick);
    el.canvas.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    el.canvas.addEventListener('wheel', onWheel, { passive: false });
    el.canvas.addEventListener('contextmenu', onCanvasContextMenu);

    if (el.annCtxReconfirm) {
      el.annCtxReconfirm.addEventListener('click', () => {
        const id = annContextMenuTargetId;
        closeAnnContextMenu();
        if (id != null) reconfirmAnnotationMeaning(id);
      });
    }

    document.addEventListener('click', (e) => {
      if (!el.lineStyleControl.contains(e.target)) closeLineStyleMenu();
      if (el.autoLearnMenuWrap && !el.autoLearnMenuWrap.contains(e.target)) closeAutoLearnMenu();
      if (el.annContextMenu && !el.annContextMenu.contains(e.target)) closeAnnContextMenu();
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
        ? 'Stitch mode — callout numbers hidden, POM 2 & 4 not forced dashed.'
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
      } else if (evalResult.status === 'needsConfirmation') {
        openPomMeaningPopover(evalResult);
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

  // ---- Phase 3: POM meaning confirmation popover ----
  // Opens once per (POM 6+ × machine) when the TD labels a line whose
  // meaning hasn't been confirmed. Picking a suggestion (or naming a
  // brand-new measurement) records the learning sample and remembers
  // the POM→meaning binding for every future file. Skip drops the
  // sample without poisoning the bucket.

  let pendingMeaningEval = null;
  let pmpOtherInputEl = null;

  function openPomMeaningPopover(evalResult) {
    if (!el.pomMeaningPopover) return;
    closeAnnContextMenu();
    pendingMeaningEval = evalResult;
    el.pmpPomLabel.textContent = 'POM ' + evalResult.pom;
    renderPomMeaningSuggestions(evalResult);
    resetPomMeaningOtherMode();
    const screen = worldToScreen(evalResult.ann.label.x, evalResult.ann.label.y);
    el.pomMeaningPopover.style.left = screen.x + 'px';
    el.pomMeaningPopover.style.top  = screen.y + 'px';
    el.pomMeaningPopover.style.display = 'block';
  }

  function closePomMeaningPopover() {
    if (!el.pomMeaningPopover) return;
    el.pomMeaningPopover.style.display = 'none';
    el.pmpSuggestions.innerHTML = '';
    resetPomMeaningOtherMode();
    pendingMeaningEval = null;
  }

  function renderPomMeaningSuggestions(evalResult) {
    el.pmpSuggestions.innerHTML = '';
    for (const m of evalResult.suggestions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmp-suggestion';
      const top = document.createElement('span');
      top.textContent = m.label;
      const sub = document.createElement('span');
      sub.className = 'pmp-anchors';
      sub.textContent = m.start + ' → ' + m.end;
      btn.appendChild(top);
      btn.appendChild(sub);
      btn.addEventListener('click', () => choosePomMeaning(m.id));
      el.pmpSuggestions.appendChild(btn);
    }
    if (evalResult.suggestions.length === 0) {
      const note = document.createElement('div');
      note.className = 'pmp-anchors';
      note.textContent = 'No close matches — add a new measurement below.';
      el.pmpSuggestions.appendChild(note);
    }
  }

  function choosePomMeaning(meaningId) {
    if (!pendingMeaningEval) return;
    const evalResult = pendingMeaningEval;
    const ok = commitMeaningChoice(evalResult, meaningId);
    if (ok) showToast('POM ' + evalResult.ann.learnSamplePom + ' learning sample saved');
    closePomMeaningPopover();
    updateUI();
    requestRender();
  }

  function submitCustomPomMeaning(label) {
    if (!pendingMeaningEval) return;
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) return;
    const evalResult = pendingMeaningEval;
    const ok = commitMeaningChoiceCustom(evalResult, cleanLabel);
    if (ok) showToast('POM ' + evalResult.ann.learnSamplePom + ' learning sample saved');
    else showToast('Could not match the line to anchors — skipped.');
    closePomMeaningPopover();
    updateUI();
    requestRender();
  }

  function resetPomMeaningOtherMode() {
    if (pmpOtherInputEl) {
      pmpOtherInputEl.remove();
      pmpOtherInputEl = null;
    }
    if (el.pmpOtherBtn) el.pmpOtherBtn.style.display = '';
  }

  function showPomMeaningOtherMode() {
    if (!el.pmpOtherBtn) return;
    el.pmpOtherBtn.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pmp-other-input';
    input.placeholder = 'Name this measurement…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submitCustomPomMeaning(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePomMeaningPopover();
      }
    });
    el.pmpOtherBtn.parentNode.appendChild(input);
    pmpOtherInputEl = input;
    requestAnimationFrame(() => input.focus());
  }

  // ---- Phase 3.6: Reconfirm Meaning context menu ----
  // Right-clicking an annotation in Manual Mode opens a small menu with
  // "Reconfirm Meaning". Picking it forgets the current (style, POM)
  // binding, clears the per-annotation dedup hash so the same line can be
  // re-evaluated, then re-runs evaluateManualPomSample which surfaces the
  // popover again. The line itself is never touched. Disabled for POMs
  // 1/3/5 (fixed) and 2/4 (extension lines) — there is nothing to
  // reconfirm in either case.

  let annContextMenuTargetId = null;

  function isReconfirmableAnn(ann) {
    if (!ann || ann.auto === true) return false;
    if (state.appMode === 'auto') return false;
    const pom = parsePomNumberFromLabel(ann.text);
    if (!pom) return false;
    const n = Number(pom);
    return n >= 6 && n <= 16;
  }

  function onCanvasContextMenu(e) {
    e.preventDefault();
    // Auto Mode owns the canvas — no manual meaning workflow available.
    if (state.appMode === 'auto') { closeAnnContextMenu(); return; }
    // Don't stack a context menu on top of the meaning popover —
    // the popover already owns the next click and the keyboard.
    if (pendingMeaningEval) { closeAnnContextMenu(); return; }
    const screen = getMousePos(e);
    const world = screenToWorld(screen.x, screen.y);
    const hit = hitTestAnnotations(world);
    if (!hit) { closeAnnContextMenu(); return; }
    const ann = getAnnotationById(hit.id);
    if (!ann) { closeAnnContextMenu(); return; }
    setSelection('annotation', ann.id);
    openAnnContextMenu(ann, e.clientX, e.clientY);
  }

  function openAnnContextMenu(ann, clientX, clientY) {
    if (!el.annContextMenu || !el.annCtxReconfirm) return;
    annContextMenuTargetId = ann.id;
    const reconfirmable = isReconfirmableAnn(ann);
    el.annCtxReconfirm.disabled = !reconfirmable;
    el.annCtxReconfirm.title = reconfirmable
      ? 'Forget the current meaning for this POM and re-open the picker.'
      : 'Reconfirm only applies to POM 6–16 labelled lines in Manual Mode.';
    // Position relative to the canvas wrapper (which is positioned).
    const wrap = el.annContextMenu.offsetParent || document.body;
    const rect = wrap.getBoundingClientRect();
    el.annContextMenu.style.left = (clientX - rect.left) + 'px';
    el.annContextMenu.style.top  = (clientY - rect.top)  + 'px';
    el.annContextMenu.style.display = 'block';
  }

  function closeAnnContextMenu() {
    if (!el.annContextMenu) return;
    el.annContextMenu.style.display = 'none';
    annContextMenuTargetId = null;
  }

  function reconfirmAnnotationMeaning(annId) {
    const ann = getAnnotationById(annId);
    if (!ann) return;
    if (!isReconfirmableAnn(ann)) {
      showToast('Reconfirm Meaning only applies to POM 6–16 lines in Manual Mode.');
      return;
    }
    const pom = parsePomNumberFromLabel(ann.text);
    if (!pom) return;
    // Drop the (currentStyle, POM) binding so resolvePomMeaning returns
    // null and evaluateManualPomSample falls through to the popover path.
    forgetPomMeaning(pom);
    // Clear the per-annotation dedup hash. Without this the next eval
    // short-circuits because endpoint coords haven't changed since the
    // last commit, and the picker would never re-open.
    ann.learnSampleHash = null;
    const evalResult = evaluateManualPomSample(ann);
    if (evalResult.status === 'needsConfirmation') {
      openPomMeaningPopover(evalResult);
    } else if (evalResult.status === 'recorded') {
      // Shouldn't happen for POM 6+ (we just forgot the binding) but
      // covered for safety: the sample was re-recorded because the
      // meaning is fixed. POM 1/3/5 hit this branch in theory, but
      // isReconfirmableAnn already rejected them above.
      showToast('POM ' + evalResult.pom + ' meaning re-confirmed.');
    } else {
      showToast('Re-open the line on a sketch image to reconfirm its meaning.');
    }
  }

  // ---- Phase 3.5: Manage POM meanings picker ----
  // Lists every confirmed (POM N → meaning) for the current style. Each
  // row has a dropdown to switch to a different meaning, and a Forget
  // button that wipes the binding so the next commit re-asks. Lets the
  // TD recover from a wrong confirmation without nuking everything.
  function openManageMeaningsPicker() {
    const styleId = currentStyleId();
    const styleLabel = styleId === '__default__'
      ? 'default bucket (no style code)'
      : 'style "' + styleId + '"';
    const dialog = buildDialog({
      title: 'POM meanings — ' + styleLabel,
      sub: 'Change a wrong confirmation or forget it so the next POM commit re-asks.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body manage-meanings-body';

    const rows = listConfirmedMeanings(styleId);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mm-empty';
      empty.textContent = 'No POM meanings confirmed for this style yet. Label a manual POM 6+ line to add one.';
      body.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'mm-list';
      const catalog = getAllCatalogMeanings();
      for (const row of rows) {
        list.appendChild(buildManageMeaningRow(row, catalog, styleId, dialog, list));
      }
      body.appendChild(list);
    }

    dialog.panel.appendChild(body);
    dialog.open();
  }

  function buildManageMeaningRow(row, catalog, styleId, dialog, listEl) {
    const node = document.createElement('div');
    node.className = 'mm-row';

    const pomEl = document.createElement('div');
    pomEl.className = 'mm-pom';
    pomEl.textContent = 'POM ' + row.pom;
    node.appendChild(pomEl);

    const select = document.createElement('select');
    select.className = 'mm-select';
    for (const m of catalog) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === row.meaning.id) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      confirmPomMeaning(row.pom, select.value);
      showToast('POM ' + row.pom + ' meaning changed.');
      updateUI();
    });
    node.appendChild(select);

    const forgetBtn = document.createElement('button');
    forgetBtn.type = 'button';
    forgetBtn.className = 'mm-forget';
    forgetBtn.textContent = 'Forget';
    forgetBtn.title = 'Forget this binding. Next POM ' + row.pom + ' commit will re-ask.';
    forgetBtn.addEventListener('click', () => {
      if (!window.confirm('Forget POM ' + row.pom + ' meaning? Next time you label a POM ' + row.pom + ' line, the picker will appear again.')) return;
      forgetPomMeaning(row.pom, styleId);
      node.remove();
      showToast('POM ' + row.pom + ' meaning forgotten.');
      updateUI();
      if (listEl && listEl.children.length === 0) dialog.close();
    });
    node.appendChild(forgetBtn);

    return node;
  }

  // ---- Calibration ----
  function setScaleFromSelection() {
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
    openScaleDialog(px);
  }

  function clearScale() {
    if (state.calibration.unitsPerPx == null) return;
    state.calibration = { unitsPerPx: null, unit: state.calibration.unit };
    pushHistoryIfChanged();
    showToast('Scale cleared. Values are now manual only.');
    updateUI();
    requestRender();
  }

  // ---- Measurement table panel ----
  function renderSpecPanel() {
    renderSpecCalNote();
    // Only preserve focus when the user is mid-edit in a project-row text
    // field. Draft rows have no editable inputs, so Approve / R/O buttons
    // must always allow a full rebuild — otherwise row badges and the
    // review-header counts go stale (e.g. Approved/Edited badges, the
    // "N approved" line in the panel header).
    const active = document.activeElement;
    const editingProjectField = active
      && el.specBody.contains(active)
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      && !!active.closest('tr[data-ann-id]');
    if (editingProjectField) {
      updateSpecHighlightOnly();
      return;
    }
    el.specBody.innerHTML = '';

    // Auto Mode: render the 16-row draft review section first.
    if (state.appMode === 'auto') {
      renderAutoReviewHeader();
      const drafts = state.autoMode.draftAnnotations
        .slice()
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const draft of drafts) {
        el.specBody.appendChild(buildDraftRow(draft));
      }
    }

    const anns = state.annotations.slice().sort((a, b) => labelSortKey(a) - labelSortKey(b) || a.seq - b.seq);
    const showEmptyHint = anns.length === 0
      && (state.appMode !== 'auto' || state.autoMode.draftAnnotations.length === 0);
    el.specEmpty.style.display = showEmptyHint ? 'block' : 'none';

    // Build a lookup by effective POM label so primary rows can find their
    // paired secondary (POM 2 next to 1, POM 4 next to 3).
    const annByPom = new Map();
    for (const ann of anns) annByPom.set(getLabelText(ann), ann);

    const renderedIds = new Set();
    for (const ann of anns) {
      if (renderedIds.has(ann.id)) continue;
      const pomKey = getLabelText(ann);
      // Skip secondary rows whose primary partner is also on the board —
      // the primary will render both into a single combined row.
      const primaryPartner = POM_PAIR_SECONDARIES[pomKey];
      if (primaryPartner && annByPom.has(primaryPartner)) continue;

      const pairRule = POM_PAIR_PRIMARIES[pomKey];
      const partnerAnn = pairRule ? annByPom.get(pairRule.partner) : null;
      if (pairRule && partnerAnn) {
        el.specBody.appendChild(buildPairedSpecRow(ann, partnerAnn, pairRule));
        renderedIds.add(ann.id);
        renderedIds.add(partnerAnn.id);
      } else {
        el.specBody.appendChild(buildSingleSpecRow(ann));
        renderedIds.add(ann.id);
      }
    }
  }

  // Standard one-annotation spec row (POM | Description | Value).
  function buildSingleSpecRow(ann) {
    const tr = document.createElement('tr');
    tr.dataset.annId = ann.id;
    if (state.selection.kind === 'annotation' && state.selection.id === ann.id) {
      tr.className = 'selected';
    }
    tr.addEventListener('click', () => setSelection('annotation', ann.id));

    const { td: pomTd, getValue: getPomValue } = buildPomCell(ann);
    const { td: descTd, input: descInput } = buildDescCell(ann);
    const { td: valTd, input: valInput } = buildValueCell(ann);

    // Wire the POM input → live placeholder updates on desc + value.
    const pomInputEl = pomTd.querySelector('input');
    if (pomInputEl) {
      pomInputEl.addEventListener('input', () => {
        const effectivePom = getPomValue() || String(ann.seq);
        descInput.placeholder = getPomInfo(effectivePom).desc || '—';
        valInput.placeholder = placeholderFor(ann, effectivePom);
      });
    }

    tr.appendChild(pomTd);
    tr.appendChild(descTd);
    tr.appendChild(valTd);
    return tr;
  }

  // Paired spec row: two annotations (primary + secondary) share one row,
  // showing the combined description and two value inputs side-by-side.
  // Clicking the row selects the primary annotation; each value input still
  // writes to its own underlying annotation so the data model stays at 16
  // POMs.
  function buildPairedSpecRow(primary, secondary, rule) {
    const tr = document.createElement('tr');
    tr.dataset.annId = primary.id;
    tr.dataset.pairAnnId = secondary.id;
    if (state.selection.kind === 'annotation'
        && (state.selection.id === primary.id || state.selection.id === secondary.id)) {
      tr.className = 'selected';
    }
    tr.addEventListener('click', () => setSelection('annotation', primary.id));

    // POM column — non-editable combined badge ("1/2" or "3/4") so the user
    // can see at a glance these two POMs share a measurement.
    const pomTd = document.createElement('td');
    const pomBadge = document.createElement('span');
    pomBadge.className = 'spec-pom-pair';
    pomBadge.textContent = getLabelText(primary) + ' / ' + getLabelText(secondary);
    pomTd.appendChild(pomBadge);
    appendConfidenceBadge(pomTd, primary);

    // Description — editable on the primary annotation, placeholder uses
    // the merged description label.
    const descTd = document.createElement('td');
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'spec-desc';
    descInput.value = primary.desc != null ? primary.desc : '';
    descInput.placeholder = rule.desc;
    const refreshPairTitle = () => { descInput.title = descInput.value || descInput.placeholder || ''; };
    refreshPairTitle();
    descInput.addEventListener('focus', () => setSelection('annotation', primary.id));
    descInput.addEventListener('input', refreshPairTitle);
    descInput.addEventListener('change', () => {
      const v = descInput.value.trim();
      const next = v === '' ? null : v;
      if (primary.desc !== next) { primary.desc = next; pushHistoryIfChanged(); }
      refreshPairTitle();
    });
    descTd.appendChild(descInput);

    // Value column — two inputs side-by-side, each labeled with its sub-meaning.
    const valTd = document.createElement('td');
    const pairWrap = document.createElement('div');
    pairWrap.className = 'spec-val-pair';
    pairWrap.appendChild(buildPairedValueField(primary, rule.primaryLabel));
    pairWrap.appendChild(buildPairedValueField(secondary, rule.secondaryLabel));
    valTd.appendChild(pairWrap);

    tr.appendChild(pomTd);
    tr.appendChild(descTd);
    tr.appendChild(valTd);
    return tr;
  }

  function buildPairedValueField(ann, sublabel) {
    const wrap = document.createElement('div');
    wrap.className = 'spec-val-field';
    const tag = document.createElement('span');
    tag.className = 'spec-val-tag';
    tag.textContent = sublabel;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spec-val';
    input.value = ann.value != null ? ann.value : '';
    input.placeholder = autoValuePlaceholder(ann);
    input.addEventListener('focus', () => setSelection('annotation', ann.id));
    input.addEventListener('change', () => {
      const v = input.value.trim();
      const next = v === '' ? null : v;
      if (ann.value !== next) { ann.value = next; pushHistoryIfChanged(); }
      input.placeholder = autoValuePlaceholder(ann);
    });
    wrap.appendChild(tag);
    wrap.appendChild(input);
    return wrap;
  }

  function buildPomCell(ann) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spec-pom';
    input.value = ann.text != null ? ann.text : '';
    input.placeholder = String(ann.seq);
    input.addEventListener('focus', () => setSelection('annotation', ann.id));
    input.addEventListener('change', () => {
      const v = input.value.trim();
      const next = v === '' ? null : v;
      if (ann.text !== next) { ann.text = next; pushHistoryIfChanged(); requestRender(); }
    });
    td.appendChild(input);
    appendConfidenceBadge(td, ann);
    return { td, getValue: () => input.value.trim() };
  }

  function appendConfidenceBadge(td, ann) {
    if (!isAutoDraft(ann)) return;
    if (ann.tdEdited) {
      const edited = document.createElement('div');
      edited.className = 'spec-conf edited';
      edited.textContent = 'edited';
      edited.title = 'This line was placed by Auto Mode and adjusted manually.';
      td.appendChild(edited);
      return;
    }
    const conf = ann.confidence;
    if (conf !== 'high' && conf !== 'medium' && conf !== 'low') return;
    const badge = document.createElement('div');
    badge.className = 'spec-conf ' + conf;
    badge.textContent = conf;
    badge.title = 'Auto Mode placement confidence: ' + conf + '.';
    td.appendChild(badge);
  }

  function buildDescCell(ann) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spec-desc';
    input.value = ann.desc != null ? ann.desc : '';
    input.placeholder = getPomInfo(getLabelText(ann)).desc || '—';
    const refreshTitle = () => { input.title = input.value || input.placeholder || ''; };
    refreshTitle();
    input.addEventListener('focus', () => setSelection('annotation', ann.id));
    input.addEventListener('input', refreshTitle);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      const next = v === '' ? null : v;
      if (ann.desc !== next) { ann.desc = next; pushHistoryIfChanged(); }
      refreshTitle();
    });
    td.appendChild(input);
    return { td, input };
  }

  function buildValueCell(ann) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spec-val';
    input.value = ann.value != null ? ann.value : '';
    input.placeholder = autoValuePlaceholder(ann);
    input.addEventListener('focus', () => setSelection('annotation', ann.id));
    input.addEventListener('change', () => {
      const v = input.value.trim();
      const next = v === '' ? null : v;
      if (ann.value !== next) { ann.value = next; pushHistoryIfChanged(); }
      input.placeholder = autoValuePlaceholder(ann);
    });
    td.appendChild(input);
    return { td, input };
  }

  function labelSortKey(ann) {
    const m = String(getLabelText(ann)).match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 9999;
  }

  function renderSpecCalNote() {
    let note = 'Label a callout with its <b>POM number</b> (e.g. 8) to auto-fill its description and standard size-L value. Values are editable per style.';
    if (state.calibration.unitsPerPx != null) {
      note += ' Scale set — non-POM lines estimated in <b>' + state.calibration.unit + '</b>.';
    }
    if (state.appMode === 'auto') {
      const det = state.autoMode.detection;
      const anchors = state.autoMode.anchors;
      const drafts = state.autoMode.draftAnnotations;
      if (drafts.length > 0) {
        note = 'Auto Mode — <b>review drafts</b>: approve, mark review-only, or drag endpoints to edit. Then <i>Apply Approved Lines</i>.';
      } else if (anchors.length > 0) {
        const edited = anchors.filter(a => !a.autoFilled).length;
        note = '<b>Auto Mode — anchors placed.</b> ' + anchors.length + ' anchors' +
          (edited > 0 ? ' (' + edited + ' adjusted)' : ' (all auto-seeded)') +
          '. Drag any that look wrong, then click <b>Generate POM Drafts</b>.';
      } else if (det) {
        const pct = (det.coverage * 100).toFixed(1);
        const features = [];
        features.push('band');
        if (det.chestY != null) features.push('chest');
        if (det.cradleY != null) features.push('cradle');
        if (det.sideLeftX != null) features.push('seam L');
        if (det.sideRightX != null) features.push('seam R');
        if (det.apexLeft) features.push('apex L');
        if (det.apexRight) features.push('apex R');
        if (det.strapTop && det.strapBottom) features.push('strap');
        if (det.back && det.back.top && det.back.bottom) features.push('back center');
        const sym = det.symmetry != null ? ' • sym ' + Math.round(det.symmetry * 100) + '%' : '';
        const fit = det.quality != null
          ? ' • fit ' + (det.quality >= 0.65 ? 'A' : (det.quality >= 0.40 ? 'B' : 'C'))
          : '';
        let views = '';
        if (det.viewBoxes && det.viewBoxes.length > 1) {
          const frontOuter = det.viewBoxes.find(v => v && (v.viewRole === 'front_outer' || v.role === 'front'));
          const frontInner = det.viewBoxes.find(v => v && v.viewRole === 'front_inner');
          const back  = det.viewBoxes.find(v => v && (v.viewRole === 'back' || v.role === 'back'));
          if (frontOuter && back && frontInner) {
            views = ' • front outer + back + front inner identified';
          } else if (frontOuter && back) {
            views = ' • front outer + back identified';
          } else if (frontOuter) {
            views = ' • ' + det.viewBoxes.length + ' views, front outer identified';
          } else {
            views = ' • ' + det.viewBoxes.length + ' views, using #' + ((det.primaryViewIndex || 0) + 1);
          }
          if (det.viewRoleReviewRequired) views += ' • roles need review';
        }
        note = '<b>Auto Mode — detected sketch.</b> ' + det.sampleWidth + '×' + det.sampleHeight +
          ' • local offline vision' + views + ' • ' + pct + '% coverage' + sym + fit +
          (det.durationMs != null ? ' • ' + det.durationMs + 'ms' : '') +
          '<br><span class="muted">Features: ' + features.join(', ') +
          '</span>. Next: drag any wrong anchors, then <i>Generate POM Drafts</i>.';
      } else {
        note = 'Auto Mode — click <b>Detect Sketch</b> to estimate the bra shape, then anchors, then POM drafts.';
      }
    }
    el.specCal.innerHTML = note;
  }

  function renderAutoReviewHeader() {
    const auto = state.autoMode;
    const drafts = auto.draftAnnotations;
    const approvable = drafts.filter(d => !isReviewOnlyDraft(d) && !d.tdApproved);
    const highApprovable = approvable.filter(d => d.confidence === 'high');
    const approved = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
    const reviewOnly = drafts.filter(d => isReviewOnlyDraft(d)).length;

    const headerTr = document.createElement('tr');
    headerTr.className = 'draft-row';
    headerTr.style.background = 'transparent';
    const headerTd = document.createElement('td');
    headerTd.colSpan = 3;
    let html = '<div class="auto-review-head">' +
      '<b>Auto Mode draft review</b> — ' + drafts.length + ' row' + (drafts.length === 1 ? '' : 's') + ' • ' +
      approved + ' approved • ' + reviewOnly + ' review-only' +
      (auto.runId ? '<br><span style="font-weight:400">Run: ' + auto.runId + '</span>' : '') +
      '<div class="auto-review-bulk">' +
        '<button type="button" class="auto-bulk-btn" data-bulk="approve-all"' +
          (approvable.length === 0 ? ' disabled' : '') + '>' +
          'Approve all (' + approvable.length + ')' +
        '</button>' +
        '<button type="button" class="auto-bulk-btn" data-bulk="approve-high"' +
          (highApprovable.length === 0 ? ' disabled' : '') + '>' +
          'Approve high-confidence (' + highApprovable.length + ')' +
        '</button>' +
      '</div>' +
      '</div>';

    if (auto.validation && auto.validation.errors && auto.validation.errors.length) {
      html += '<div class="auto-review-errors"><b>Validation errors</b><ul>' +
        auto.validation.errors.map(e => '<li>' + escapeHtml(e) + '</li>').join('') +
        '</ul></div>';
    }
    if (auto.validation && auto.validation.warnings && auto.validation.warnings.length) {
      html += '<div class="auto-review-errors" style="background:#fffbeb;border-color:#fde68a;color:#854d0e"><b>Warnings</b><ul>' +
        auto.validation.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') +
        '</ul></div>';
    }
    if (auto.lastError) {
      html += '<div class="auto-review-errors"><b>Last error</b><br>' +
        escapeHtml(auto.lastError) + '</div>';
    }
    headerTd.innerHTML = html;
    headerTd.querySelectorAll('[data-bulk]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.getAttribute('data-bulk');
        const targets = mode === 'approve-high' ? highApprovable : approvable;
        if (targets.length === 0) return;
        for (const d of targets) approveDraftAnnotation(d);
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        showToast('Approved ' + targets.length + ' draft' + (targets.length === 1 ? '' : 's') + '.');
      });
    });
    headerTr.appendChild(headerTd);
    el.specBody.appendChild(headerTr);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function buildDraftRow(draft) {
    const tr = document.createElement('tr');
    tr.dataset.draftId = draft.id;
    tr.classList.add('draft-row');
    if (isReviewOnlyDraft(draft)) tr.classList.add('review-only');
    if (draft.tdApproved) tr.classList.add('approved');
    if (state.selection.kind === 'draft' && state.selection.id === draft.id) {
      tr.classList.add('selected');
    }
    tr.addEventListener('click', () => setSelection('draft', draft.id));

    const pomTd = document.createElement('td');
    const pomLabel = document.createElement('span');
    pomLabel.textContent = draft.text != null ? String(draft.text) : String(draft.seq);
    pomLabel.style.fontWeight = '700';
    pomTd.appendChild(pomLabel);
    const status = document.createElement('span');
    status.className = 'draft-status';
    if (isReviewOnlyDraft(draft)) status.textContent = 'Review-only';
    else if (draft.tdApproved) status.textContent = 'Approved';
    else if (draft.tdEdited) status.textContent = 'Edited';
    else status.textContent = draft.drawability === 'APPROXIMATE' ? 'Approx' : 'Draft';
    pomTd.appendChild(status);

    const descTd = document.createElement('td');
    const descBody = document.createElement('div');
    const standardDesc = getPomInfo(draft.text || draft.seq).desc || '—';
    descBody.textContent = standardDesc;
    descBody.title = standardDesc;
    descTd.appendChild(descBody);
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10.5px;color:#6b7280;margin-top:2px;line-height:1.35';
    const metaBits = [];
    if (draft.confidence) metaBits.push('conf: ' + draft.confidence);
    if (draft.reason) metaBits.push(draft.reason);
    if (draft.uncertainty && isReviewOnlyDraft(draft)) metaBits.push(draft.uncertainty);
    if (metaBits.length) meta.textContent = metaBits.join(' • ');
    descTd.appendChild(meta);

    const actionsTd = document.createElement('td');
    actionsTd.style.cssText = 'white-space:nowrap';

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.textContent = draft.tdApproved ? 'Approved' : 'Approve';
    approveBtn.disabled = isReviewOnlyDraft(draft) || draft.tdApproved;
    approveBtn.style.cssText = 'padding:3px 8px;font-size:11px;margin-right:4px';
    approveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      blurActivePanelField();
      setSelection('draft', draft.id);
      approveDraftAnnotation(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    actionsTd.appendChild(approveBtn);

    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.textContent = 'R/O';
    reviewBtn.title = 'Mark this row REVIEW_ONLY';
    reviewBtn.disabled = isReviewOnlyDraft(draft);
    reviewBtn.style.cssText = 'padding:3px 8px;font-size:11px';
    reviewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      blurActivePanelField();
      setSelection('draft', draft.id);
      markDraftReviewOnly(draft);
      pushHistoryIfChanged();
      updateUI();
      requestRender();
    });
    actionsTd.appendChild(reviewBtn);

    tr.appendChild(pomTd);
    tr.appendChild(descTd);
    tr.appendChild(actionsTd);
    return tr;
  }

  function blurActivePanelField() {
    // Drop focus off any input/button inside the spec panel so the next
    // renderSpecPanel pass is free to rebuild rows (Approve / R/O state).
    const active = document.activeElement;
    if (active && el.specBody.contains(active) && typeof active.blur === 'function') {
      active.blur();
    }
  }

  function updateSpecHighlightOnly() {
    const rows = el.specBody.querySelectorAll('tr');
    rows.forEach((tr) => {
      const selId = state.selection.kind === 'annotation' ? String(state.selection.id) : null;
      const isAnnSel = selId != null
        && (selId === tr.dataset.annId || selId === tr.dataset.pairAnnId);
      const isDraftSel = state.selection.kind === 'draft' && String(state.selection.id) === tr.dataset.draftId;
      tr.classList.toggle('selected', isAnnSel || isDraftSel);
    });
  }

  function autoValuePlaceholder(ann) {
    return placeholderFor(ann, getLabelText(ann));
  }

  // Value placeholder priority: POM standard reference > calibration estimate > none.
  function placeholderFor(ann, labelText) {
    const pom = getPomInfo(labelText);
    if (pom.refL != null) return 'std ' + pom.refL + ' ' + POM_UNIT;
    if (state.calibration.unitsPerPx != null) {
      return '≈ ' + formatMeasure(lineLength(ann) * state.calibration.unitsPerPx) + ' ' + state.calibration.unit;
    }
    return '—';
  }

  function updateUI() {
    el.toolSelect.classList.toggle('active', state.tool === 'select');
    el.toolStraight.classList.toggle('active', state.tool === 'straight');
    el.toolCurved.classList.toggle('active', state.tool === 'curved');
    el.toolEraser.classList.toggle('active', state.tool === 'eraser');
    el.toolEraser.disabled = state.images.length === 0;
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
    const activeStyle = selectedAnnotation ? getLineStyle(selectedAnnotation) : state.drawStyle;
    const activeColor = selectedAnnotation ? normalizeColorKey(selectedAnnotation.color) : state.drawColor;
    const activeArrowType = selectedAnnotation ? getArrowType(selectedAnnotation) : state.arrowType;
    const activeLineWidth = getActiveLineWidth();
    updateLineStyleControl(activeStyle);
    if (el.lineWidthInput && document.activeElement !== el.lineWidthInput) {
      el.lineWidthInput.value = formatLineWidth(activeLineWidth);
    }
    el.arrowDoubleBtn.classList.toggle('active', activeArrowType === 'double');
    el.arrowSingleBtn.classList.toggle('active', activeArrowType === 'single');
    el.arrowNoneBtn.classList.toggle('active', activeArrowType === 'none');
    el.colorRedBtn.classList.toggle('active', activeColor === 'red');
    el.colorBlueBtn.classList.toggle('active', activeColor === 'blue');
    el.colorBlackBtn.classList.toggle('active', activeColor === 'black');
    el.colorWhiteBtn.classList.toggle('active', activeColor === 'white');

    // Lock line style/arrow controls for POMs with an enforced style (e.g. 2 and 4).
    const styleLocked = !!(selectedAnnotation && forcedStyleFor(selectedAnnotation));
    el.stitchesBtn.disabled = styleLocked;
    if (styleLocked) closeLineStyleMenu();
    el.arrowDoubleBtn.disabled = styleLocked;
    el.arrowSingleBtn.disabled = styleLocked;
    el.arrowNoneBtn.disabled = styleLocked;

    let toolText = '';
    if (state.tool === 'select') {
      if (selectedAnnotation) {
        toolText = 'Select – Drag line, endpoints, curve controls, or label. Use wheel to zoom, or hold <span class="kbd">Space</span> to pan.';
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
      toolText = state.drawSession
        ? 'Curved Line – Click second point to finish the curve.'
        : 'Curved Line – Click first point.';
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
    el.deleteBtn.disabled = !(selectedAnnotation || (selectedImage && !selectedImage.locked));
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
    renderSpecPanel();
  }

  function updateAutoModeUI() {
    const isAuto = state.appMode === 'auto';
    // Mode switch buttons
    el.modeManualBtn.classList.toggle('active', !isAuto);
    el.modeAutoBtn.classList.toggle('active', isAuto);

    // Lock manual creation/edit tools while in Auto Mode.
    el.toolStraight.disabled = isAuto;
    el.toolCurved.disabled = isAuto;
    if (isAuto) {
      el.toolEraser.disabled = true;
      el.deleteBtn.disabled = true;
      el.clearBtn.disabled = true;
    }

    if (!isAuto) {
      el.autoStatusChip.dataset.status = 'idle';
      el.autoStatusChip.textContent = 'idle';
      return;
    }

    const auto = state.autoMode;
    const draftCount = auto.draftAnnotations.length;
    const approvedCount = auto.draftAnnotations.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
    const hasSource = !!pickAutoSourceImage();

    el.autoStatusChip.dataset.status = auto.status;
    el.autoStatusChip.textContent = auto.status;

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
      ? 'Generate 16 POM drafts from the current anchor positions'
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

  function showToast(message, duration = 2600) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
    }, duration);
  }

function resizeCanvas() {
  const previousRect = state.lastCanvasRect;
  const worldCenter = previousRect
    ? {
        x: (previousRect.width / 2 - state.panX) / state.zoom,
        y: (previousRect.height / 2 - state.panY) / state.zoom,
      }
    : null;

  const rect = el.canvas.getBoundingClientRect();
  state.lastCanvasRect = rect;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  el.canvas.width = Math.round(rect.width * dpr);
  el.canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (worldCenter) {
    state.panX = rect.width / 2 - worldCenter.x * state.zoom;
    state.panY = rect.height / 2 - worldCenter.y * state.zoom;
  }

  requestRender();
}

  function seedHistory() {
    const snap = makeSnapshot();
    state.history.past = [{ snapshot: snap, fingerprint: snapshotFingerprint(snap) }];
    state.history.future = [];
  }

  function makeSnapshot() {
    return {
      tool: state.tool,
      drawStyle: state.drawStyle,
      drawColor: state.drawColor,
      arrowType: state.arrowType,
      lineWidth: state.lineWidth,
      annotations: clone(state.annotations),
      images: state.images.map(stripImageForSnapshot),
      eraseStrokes: clone(state.eraseStrokes),
      nextSequence: state.nextSequence,
      selection: clone(state.selection),
      idCounter: state.idCounter,
      calibration: clone(state.calibration),
    };
  }

  // Snapshots reference images by id only; the heavy base64 lives in imageDataById.
  function stripImageForSnapshot(image) {
    return {
      id: image.id,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
      locked: !!image.locked,
    };
  }

  function snapshotFingerprint(snapshot) {
    return JSON.stringify(snapshot);
  }

  function pushHistoryIfChanged() {
    if (state.history.restoring) return;
    const snap = makeSnapshot();
    const fingerprint = snapshotFingerprint(snap);
    const last = state.history.past[state.history.past.length - 1];
    if (last && last.fingerprint === fingerprint) return;

    state.history.past.push({ snapshot: snap, fingerprint });
    if (state.history.past.length > HISTORY_LIMIT) {
      state.history.past.shift();
    }
    state.history.future = [];
    updateUI();
  }

  async function restoreSnapshot(snapshot) {
    state.history.restoring = true;
    state.tool = snapshot.tool || 'select';
    state.drawStyle = snapshot.drawStyle || 'solid';
    state.drawColor = snapshot.drawColor || 'red';
    state.arrowType = snapshot.arrowType || 'double';
    state.lineWidth = normalizeLineWidth(snapshot.lineWidth);
    state.annotations = clone(snapshot.annotations || []);
    state.eraseStrokes = clone(snapshot.eraseStrokes || []);
    state.nextSequence = snapshot.nextSequence || (state.annotations.length + 1);
    state.selection = snapshot.selection || { kind: null, id: null };
    state.idCounter = snapshot.idCounter || inferNextIdCounter();
    state.calibration = snapshot.calibration || { unitsPerPx: null, unit: 'cm' };
    state.editingLabelId = null;
    state.drawSession = null;
    state.eraseSession = null;
    state.interaction = null;
    document.body.classList.toggle('tool-eraser', state.tool === 'eraser');

    state.images = await Promise.all((snapshot.images || []).map(async (meta) => {
      const dataURL = imageDataById.get(meta.id) || meta.dataURL;
      const img = await loadImageFromDataURL(dataURL);
      return { ...meta, dataURL, img };
    }));

    if (state.selection.kind === 'annotation' && !state.annotations.some(a => a.id === state.selection.id)) {
      state.selection = { kind: null, id: null };
    }
    if (state.selection.kind === 'image' && !state.images.some(i => i.id === state.selection.id)) {
      state.selection = { kind: null, id: null };
    }

    state.history.restoring = false;
    updateUI();
    requestRender();
  }

  async function undo() {
    if (state.history.past.length <= 1) return;
    const current = state.history.past.pop();
    state.history.future.push(current);
    const target = state.history.past[state.history.past.length - 1];
    await restoreSnapshot(target.snapshot);
  }

  async function redo() {
    if (!state.history.future.length) return;
    const next = state.history.future.pop();
    state.history.past.push(next);
    await restoreSnapshot(next.snapshot);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function inferNextIdCounter() {
    let max = 0;
    for (const ann of state.annotations) max = Math.max(max, Number(ann.id) || 0);
    for (const image of state.images) max = Math.max(max, Number(image.id) || 0);
    for (const draft of state.autoMode.draftAnnotations) max = Math.max(max, Number(draft.id) || 0);
    return max + 1;
  }


  async function onPasteEvent(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(item => item.type && item.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const dataURLs = [];
    for (const imageItem of imageItems) {
      const blob = imageItem.getAsFile();
      if (!blob) continue;
      dataURLs.push(await blobToDataURL(blob));
    }
    if (dataURLs.length) {
      await addImagesFromDataURLs(dataURLs);
    }
  }

  async function addImagesFromDataURLs(dataURLs) {
    const hadImages = state.images.length > 0;
    const baseCount = state.images.length;
    let added = 0;

    for (let batchIndex = 0; batchIndex < dataURLs.length; batchIndex += 1) {
      const dataURL = dataURLs[batchIndex];
      const img = await loadImageFromDataURL(dataURL);
      const imageRecord = createImageRecord(img, dataURL, baseCount + batchIndex);
      state.images.push(imageRecord);
      state.selection = { kind: 'image', id: imageRecord.id };
      added += 1;
    }

    if (!hadImages && state.images.length > 0) {
      fitImagesToBoard();
    } else {
      updateUI();
      requestRender();
    }

    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast(added === 1 ? '1 image added to the board.' : added + ' images added to the board.');
  }

  async function onImageFileChosen(e) {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = '';
    const imageFiles = files.filter((f) => f.type && f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    const dataURLs = [];
    for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
    await addImagesFromDataURLs(dataURLs);
  }

  // ---- Drag & drop import ----
  function setupDragAndDrop() {
    const card = el.boardCard;
    if (!card) return;
    let dragDepth = 0;

    const draggingFiles = (e) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    card.addEventListener('dragenter', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      card.classList.add('drag-over');
    });
    card.addEventListener('dragover', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    card.addEventListener('dragleave', (e) => {
      if (!draggingFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) card.classList.remove('drag-over');
    });
    card.addEventListener('drop', async (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      dragDepth = 0;
      card.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) await handleDroppedFiles(files);
    });
  }

  async function handleDroppedFiles(files) {
    const imageFiles = files.filter((f) => f.type && f.type.startsWith('image/'));
    const pptxFiles = files.filter((f) =>
      /\.pptx$/i.test(f.name || '') ||
      f.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );

    if (imageFiles.length) {
      const dataURLs = [];
      for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
      await addImagesFromDataURLs(dataURLs);
    }
    // Import the first dropped deck (the picker handles one deck at a time).
    if (pptxFiles.length) await processPptxFile(pptxFiles[0]);

    if (!imageFiles.length && !pptxFiles.length) {
      showToast('Drop an image or a .pptx file to add it to the board.', 3600);
    }
  }

  async function onPptxFileChosen(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    await processPptxFile(file);
  }

  async function processPptxFile(file) {
    el.importPptxBtn.disabled = true;
    const prevLabel = el.importPptxBtn.textContent;
    el.importPptxBtn.textContent = 'Importing…';
    try {
      const buffer = await file.arrayBuffer();
      const entries = await extractSlidesFromPptx(buffer);
      if (!entries.length) {
        showToast('No usable sketch images were found in that deck.', 4200);
        return;
      }
      // Group images by their source slide so each picker choice is a whole
      // page: a slide with several pictures imports all of them together.
      const pages = groupEntriesBySlide(entries);
      if (pages.length === 1) {
        await addImagesFromDataURLs(pages[0].dataURLs);
        return;
      }
      openPptxPicker(pages);
    } catch (error) {
      console.error(error);
      showToast('Could not read that .pptx file. It may be corrupt or use an unsupported format.', 4600);
    } finally {
      el.importPptxBtn.disabled = false;
      el.importPptxBtn.textContent = prevLabel;
    }
  }

  // Collapse per-image entries [{slide, dataURL}] into per-page groups
  // [{slide, dataURLs:[...]}], preserving slide order, so a slide that holds
  // multiple pictures is presented (and imported) as a single page.
  function groupEntriesBySlide(entries) {
    const order = [];
    const bySlide = new Map();
    for (const entry of entries) {
      let page = bySlide.get(entry.slide);
      if (!page) {
        page = { slide: entry.slide, dataURLs: [] };
        bySlide.set(entry.slide, page);
        order.push(page);
      }
      page.dataURLs.push(entry.dataURL);
    }
    return order;
  }

  // Modal that previews every page found in a deck and lets the user import
  // only the ones they want, instead of dumping all slides onto the board.
  function openPptxPicker(pages) {
    const selected = new Set();

    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';

    const panel = document.createElement('div');
    panel.className = 'picker-panel';
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'picker-header';
    const title = document.createElement('h2');
    title.textContent = 'Import pages';
    const sub = document.createElement('span');
    sub.className = 'picker-sub';
    sub.textContent = pages.length + ' pages found — pick the ones to add.';
    header.appendChild(title);
    header.appendChild(sub);
    panel.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'picker-grid';
    panel.appendChild(grid);

    pages.forEach((page, index) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'picker-cell';
      cell.setAttribute('aria-pressed', 'false');

      const thumb = document.createElement('img');
      thumb.className = 'picker-thumb';
      thumb.src = page.dataURLs[0];
      thumb.alt = 'Slide ' + page.slide;
      cell.appendChild(thumb);

      const cap = document.createElement('span');
      cap.className = 'picker-cap';
      cap.textContent = page.dataURLs.length > 1
        ? 'Slide ' + page.slide + ' · ' + page.dataURLs.length + ' images'
        : 'Slide ' + page.slide;
      cell.appendChild(cap);

      cell.addEventListener('click', () => {
        if (selected.has(index)) {
          selected.delete(index);
          cell.classList.remove('selected');
          cell.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(index);
          cell.classList.add('selected');
          cell.setAttribute('aria-pressed', 'true');
        }
        updateFooter();
      });
      grid.appendChild(cell);
    });

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'picker-link';
    const count = document.createElement('span');
    count.className = 'picker-count';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'picker-btn primary';
    footer.appendChild(selectAllBtn);
    footer.appendChild(spacer);
    footer.appendChild(count);
    footer.appendChild(cancelBtn);
    footer.appendChild(importBtn);
    panel.appendChild(footer);

    function updateFooter() {
      const n = selected.size;
      count.textContent = n + ' selected';
      importBtn.disabled = n === 0;
      importBtn.textContent = n === 0 ? 'Import' : 'Import ' + n;
      selectAllBtn.textContent = n === pages.length ? 'Clear all' : 'Select all';
    }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    }

    selectAllBtn.addEventListener('click', () => {
      const all = selected.size === pages.length;
      selected.clear();
      Array.from(grid.children).forEach((cell, index) => {
        if (all) {
          cell.classList.remove('selected');
          cell.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(index);
          cell.classList.add('selected');
          cell.setAttribute('aria-pressed', 'true');
        }
      });
      updateFooter();
    });

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);

    importBtn.addEventListener('click', async () => {
      if (!selected.size) return;
      const chosen = Array.from(selected)
        .sort((a, b) => a - b)
        .flatMap(i => pages[i].dataURLs);
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        await addImagesFromDataURLs(chosen);
        close();
      } catch (error) {
        console.error(error);
        showToast('Could not import the selected pages.', 4200);
        importBtn.disabled = false;
        updateFooter();
      }
    });

    updateFooter();
    document.body.appendChild(overlay);
  }

  // ---- Lightweight modal dialogs (Help, Set Scale) ----
  // Shared shell so both dialogs look and behave the same: backdrop, header with
  // a close button, Esc / click-outside to dismiss. Returns the panel to fill.
  function buildDialog({ title, sub }) {
    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';

    const panel = document.createElement('div');
    panel.className = 'picker-panel dialog-panel';
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'picker-header dialog-header';
    const heading = document.createElement('h2');
    heading.textContent = title;
    header.appendChild(heading);
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'picker-sub';
      subEl.textContent = sub;
      header.appendChild(subEl);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dialog-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);
    panel.appendChild(header);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);

    return {
      overlay,
      panel,
      close,
      open() { document.body.appendChild(overlay); },
    };
  }

  function openHelpDialog() {
    const dialog = buildDialog({
      title: 'Help & shortcuts',
      sub: 'Everything you need to annotate a sketch.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.innerHTML = `
      <div class="help-section">
        <h3>Getting started</h3>
        <ul class="help-list">
          <li class="help-item"><span>Add a photo with <b>Add Image</b>, drag one onto the board, or paste with <span class="kbd">Ctrl</span><span class="kbd">V</span> / <span class="kbd">⌘</span><span class="kbd">V</span>.</span></li>
          <li class="help-item"><span><b>Import PPTX</b> pulls sketches straight out of a PowerPoint deck.</span></li>
        </ul>
      </div>
      <div class="help-section">
        <h3>Drawing tools</h3>
        <ul class="help-list">
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.4 3.1l13 6.1c.74.35.6 1.43-.2 1.59l-5 1-2 5c-.3.78-1.4.7-1.6-.1L4.2 4.4c-.2-.83.6-1.55 1.2-1.3z"/></svg>
            <span><b>Select</b> — click a line, label, or image to move or edit it.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="19" x2="19" y2="5"/></svg>
            <span><b>Straight line</b> — click the start point, then the end point.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 17C8 7 16 7 20 11"/></svg>
            <span><b>Curved line</b> — click start then end, then drag to bend it.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="14" x2="13" y2="14"/><line x1="13" y1="14" x2="20" y2="14" stroke-dasharray="2.2 2.2"/></svg>
            <span><b>Extension line</b> — after drawing a straight line, click once more in line with it to add a collinear dashed extension as a separate POM. Click off-axis to start a new line instead.</span>
          </li>
          <li class="help-item">
            <svg class="help-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 18.5l-3-3a2 2 0 0 1 0-2.8l7-7a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8l-6.8 6.8z"/><line x1="8.5" y1="18.5" x2="20" y2="18.5"/></svg>
            <span><b>Eraser</b> — paint white over parts of the photo you don't want.</span>
          </li>
          <li class="help-item"><span><b>Stitches</b> — switch a line between plain, dashed, zigzag, cover, or bartack stitch styles. <b>Arrow</b> and <b>color</b> controls sit next to it.</span></li>
        </ul>
      </div>
      <div class="help-section">
        <h3>Measurements</h3>
        <ul class="help-list">
          <li class="help-item"><span>Every line becomes a numbered <b>point of measure (POM)</b> in the side panel.</span></li>
          <li class="help-item"><span><b>Set Scale</b> — select a line whose real length you know, click Set Scale, type the length, and the panel estimates every other line for you.</span></li>
          <li class="help-item"><span><b>Hide Numbers</b> clears the callout numbers from the board; the panel still lists them.</span></li>
        </ul>
      </div>
      <div class="help-section">
        <h3>Keyboard shortcuts</h3>
        <div class="help-row"><span>Select tool</span><span class="help-keys"><span class="kbd">S</span></span></div>
        <div class="help-row"><span>Straight line</span><span class="help-keys"><span class="kbd">L</span></span></div>
        <div class="help-row"><span>Curved line</span><span class="help-keys"><span class="kbd">C</span></span></div>
        <div class="help-row"><span>Eraser</span><span class="help-keys"><span class="kbd">E</span></span></div>
        <div class="help-row"><span>Fit to view</span><span class="help-keys"><span class="kbd">F</span></span></div>
        <div class="help-row"><span>Hide / show numbers</span><span class="help-keys"><span class="kbd">N</span></span></div>
        <div class="help-row"><span>Undo / Redo</span><span class="help-keys"><span class="kbd">⌘</span><span class="kbd">Z</span> / <span class="kbd">⇧</span><span class="kbd">⌘</span><span class="kbd">Z</span></span></div>
        <div class="help-row"><span>Delete selected</span><span class="help-keys"><span class="kbd">Delete</span></span></div>
        <div class="help-row"><span>Pan the board</span><span class="help-keys">Hold <span class="kbd">Space</span> + drag</span></div>
        <div class="help-row"><span>Zoom</span><span class="help-keys">Mouse wheel / trackpad</span></div>
        <div class="help-row"><span>Eraser brush size</span><span class="help-keys"><span class="kbd">[</span> <span class="kbd">]</span></span></div>
        <div class="help-row"><span>Cancel / deselect</span><span class="help-keys"><span class="kbd">Esc</span></span></div>
      </div>`;
    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'picker-btn primary';
    okBtn.textContent = 'Got it';
    okBtn.addEventListener('click', dialog.close);
    footer.appendChild(spacer);
    footer.appendChild(okBtn);
    dialog.panel.appendChild(footer);

    dialog.open();
    okBtn.focus();
  }

  function openScaleDialog(px) {
    const cal = state.calibration;
    const currentUnit = cal && cal.unit ? cal.unit : 'cm';
    const currentValue = cal && cal.unitsPerPx != null
      ? +(px * cal.unitsPerPx).toFixed(3)
      : '';

    const dialog = buildDialog({
      title: 'Set scale',
      sub: 'Calibrate the board from one known length.',
    });

    const body = document.createElement('div');
    body.className = 'scale-body';
    body.innerHTML = `
      <p class="scale-lead">Type the real length of the <b>selected line</b>. Every other line on the board is then estimated from it.</p>
      <div class="scale-field">
        <input type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 70" aria-label="Real length" />
        <select aria-label="Unit">
          <option value="cm">cm</option>
          <option value="mm">mm</option>
          <option value="m">m</option>
          <option value="in">in</option>
        </select>
      </div>
      <p class="scale-note">Tip: choose a line whose true measurement you know — a band, a strap, or a ruler shown in the photo.</p>`;
    dialog.panel.appendChild(body);

    const input = body.querySelector('input');
    const select = body.querySelector('select');
    input.value = currentValue === '' ? '' : String(currentValue);
    select.value = currentUnit;

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'picker-btn primary';
    applyBtn.textContent = 'Set scale';
    footer.appendChild(spacer);
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    dialog.panel.appendChild(footer);

    function apply() {
      const value = parseFloat(input.value);
      if (!isFinite(value) || value <= 0) {
        input.focus();
        input.select();
        showToast('Enter a length greater than zero, e.g. 70.');
        return;
      }
      const unit = select.value;
      state.calibration = { unitsPerPx: value / px, unit };
      pushHistoryIfChanged();
      showToast('Scale set: the table now estimates every line in ' + unit + '.');
      updateUI();
      requestRender();
      dialog.close();
    }

    cancelBtn.addEventListener('click', dialog.close);
    applyBtn.addEventListener('click', apply);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); apply(); }
    });

    dialog.open();
    input.focus();
    input.select();
  }

  // Auto Mode exit guard. The TD has unapplied drafts
  // and is trying to leave Auto Mode (or open a project, which would
  // implicitly clear the draft layer). Offers Apply / Discard / Stay as real
  // buttons instead of a confusing free-text prompt. Resolves to one of
  // 'apply', 'discard', or 'stay'.
  function openAutoModeExitDialog({ approvedCount, totalCount, reason }) {
    const dialog = buildDialog({
      title: 'You have unapplied Auto Mode drafts',
      sub: totalCount + ' draft' + (totalCount === 1 ? '' : 's') +
        ' on the board · ' + approvedCount + ' approved.',
    });

    const body = document.createElement('div');
    body.className = 'dialog-body';
    const lead = reason
      ? '<p>' + reason + '</p>'
      : '<p>Choose what to do before leaving Auto Mode:</p>';
    body.innerHTML = lead +
      '<ul style="margin:8px 0 0; padding-left:18px; color:var(--muted);">' +
        '<li><b>Apply Approved Lines</b> moves approved drafts into the project. ' +
          'Any remaining drafts stay; you remain in Auto Mode to resolve them.</li>' +
        '<li><b>Discard Drafts</b> clears the draft layer without changing the project.</li>' +
        '<li><b>Stay</b> keeps everything as-is.</li>' +
      '</ul>';
    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';

    const stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.className = 'picker-btn';
    stayBtn.textContent = 'Stay';

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'picker-btn';
    discardBtn.textContent = 'Discard Drafts';

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'picker-btn primary';
    applyBtn.textContent = 'Apply Approved Lines';
    applyBtn.disabled = approvedCount === 0;
    if (approvedCount === 0) applyBtn.title = 'No drafts are approved yet.';

    footer.appendChild(spacer);
    footer.appendChild(stayBtn);
    footer.appendChild(discardBtn);
    footer.appendChild(applyBtn);
    dialog.panel.appendChild(footer);

    return new Promise(resolve => {
      // buildDialog wires Esc / backdrop / X-button to its own close()
      // closure — we can't intercept those paths by overriding dialog.close.
      // Watch the overlay being detached instead so every dismissal route
      // funnels through one settle().
      let choice = 'stay';
      let settled = false;
      const observer = new MutationObserver(() => {
        if (!document.body.contains(dialog.overlay)) {
          observer.disconnect();
          if (settled) return;
          settled = true;
          resolve(choice);
        }
      });
      observer.observe(document.body, { childList: true });
      stayBtn.addEventListener('click', () => { choice = 'stay'; dialog.close(); });
      discardBtn.addEventListener('click', () => { choice = 'discard'; dialog.close(); });
      applyBtn.addEventListener('click', () => { choice = 'apply'; dialog.close(); });
      dialog.open();
      (approvedCount > 0 ? applyBtn : stayBtn).focus();
    });
  }

  // ---- Save / open project ----
  function buildProjectSnapshot() {
    return {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      savedAt: new Date().toISOString(),
      state: {
        annotations: clone(state.annotations),
        images: state.images.map(img => ({
          id: img.id, dataURL: img.dataURL,
          x: img.x, y: img.y, width: img.width, height: img.height,
          locked: !!img.locked,
        })),
        eraseStrokes: clone(state.eraseStrokes),
        brushSize: state.brushSize,
        showLabels: state.showLabels,
        calibration: clone(state.calibration),
        nextSequence: state.nextSequence,
        idCounter: state.idCounter,
        drawStyle: state.drawStyle,
        drawColor: state.drawColor,
        arrowType: state.arrowType,
        lineWidth: state.lineWidth,
        zoom: state.zoom,
        panX: state.panX,
        panY: state.panY,
        styleId: state.styleId || '',
      },
    };
  }

  function saveProject() {
    if (!state.annotations.length && !state.images.length) {
      showToast('Nothing to save yet. Paste an image or draw a line first.');
      return;
    }
    if (state.appMode === 'auto' && state.autoMode.draftAnnotations.length > 0) {
      const ok = window.confirm(
        'Unapplied Auto Mode drafts will not be included in the saved project.\n\n' +
        'OK = Save Applied Project Only\nCancel = Cancel save'
      );
      if (!ok) return;
    }
    const project = buildProjectSnapshot();
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    downloadBlob(blob, makeProjectFileName());
    showToast('Project saved. Reopen it later with Open Project.');
  }

  function makeProjectFileName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return 'bra-sketch-project-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.json';
  }

  function onProjectFileChosen(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    const drafts = state.autoMode.draftAnnotations;
    if (state.appMode === 'auto' && drafts.length > 0) {
      const approvedCount = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
      openAutoModeExitDialog({
        approvedCount,
        totalCount: drafts.length,
        reason: 'Opening another project will replace the board and clear the Auto Mode draft layer. Choose what to do with the drafts first:',
      }).then(choice => {
        if (choice === 'apply') {
          const applied = applyApprovedDraftsAtomically();
          if (!applied) return;
          if (state.autoMode.draftAnnotations.length > 0) {
            showToast('Some drafts remain. Resolve them before opening another project.');
            return;
          }
          readAndLoadProjectFile(file);
        } else if (choice === 'discard') {
          discardAutoDrafts(true);
          readAndLoadProjectFile(file);
        }
        // 'stay' = cancel the open; current drafts and board are untouched.
      });
      return;
    }

    if ((state.annotations.length || state.images.length) &&
        !window.confirm('Open this project? Your current board will be replaced. Save it first if you want to keep it.')) {
      return;
    }
    readAndLoadProjectFile(file);
  }

  function readAndLoadProjectFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const project = JSON.parse(String(reader.result || ''));
        await loadProject(project);
        showToast('Project opened.');
      } catch (error) {
        console.error(error);
        showToast('Could not open that file. It may not be a saved project.', 4200);
      }
    };
    reader.onerror = () => showToast('Could not read that file.', 4200);
    reader.readAsText(file);
  }

  async function loadProject(project) {
    if (!project || project.format !== PROJECT_FORMAT || !project.state) {
      throw new Error('Unrecognized project file');
    }
    const s = project.state;

    state.annotations = clone(s.annotations || []);
    state.eraseStrokes = clone(s.eraseStrokes || []);
    state.brushSize = s.brushSize || 24;
    state.showLabels = s.showLabels !== false;
    state.calibration = s.calibration || { unitsPerPx: null, unit: 'cm' };
    state.nextSequence = s.nextSequence || (state.annotations.length + 1);
    state.drawStyle = s.drawStyle || 'solid';
    state.drawColor = s.drawColor || 'red';
    state.arrowType = s.arrowType || 'double';
    state.lineWidth = normalizeLineWidth(s.lineWidth);
    state.tool = 'select';
    state.selection = { kind: null, id: null };
    state.drawSession = null;
    state.eraseSession = null;
    state.interaction = null;
    state.editingLabelId = null;
    // Old projects load normally; unapplied drafts are not persisted.
    state.appMode = 'manual';
    state.autoMode = makeInitialAutoModeState();
    document.body.classList.remove('app-auto');
    document.body.classList.remove('tool-eraser');
    el.labelEditor.style.display = 'none';

    imageDataById.clear();
    state.images = await Promise.all((s.images || []).map(async (meta) => {
      const img = await loadImageFromDataURL(meta.dataURL);
      imageDataById.set(meta.id, meta.dataURL);
      return {
        id: meta.id, dataURL: meta.dataURL, img,
        x: meta.x, y: meta.y, width: meta.width, height: meta.height,
        locked: !!meta.locked,
      };
    }));

    state.idCounter = s.idCounter || inferNextIdCounter();
    state.zoom = clamp(s.zoom ?? 1, MIN_ZOOM, MAX_ZOOM);
    state.panX = s.panX ?? 0;
    state.panY = s.panY ?? 0;
    state.styleId = (typeof s.styleId === 'string') ? s.styleId : '';

    seedHistory();
    updateUI();
    requestRender();
  }

  // A .pptx is a ZIP container. Parse it natively and pull one or more
  // picture images per slide, in slide order, skipping tiny logo/icon art.
  // Returns slide-tagged entries [{slide, dataURL}] so the import picker can
  // show which page each image came from.
  async function extractSlidesFromPptx(buffer) {
    const zip = parseZip(buffer);
    const slideArea = await readSlideArea(zip);
    const minArea = slideArea ? slideArea * 0.03 : 0;

    const slideNames = Object.keys(zip.entries)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b));

    const entries = [];
    const seenTargets = new Set();

    for (const slideName of slideNames) {
      const xmlText = await readZipEntryText(zip, slideName);
      if (!xmlText) continue;
      const relsName = slideName.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
      const relsText = await readZipEntryText(zip, relsName);
      const relMap = parseRels(relsText);
      const slide = slideNumber(slideName);

      const picks = pickSlidePictures(xmlText, relMap, slideName, minArea);
      for (const target of picks) {
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        const dataURL = await mediaTargetToDataURL(zip, target);
        if (dataURL) entries.push({ slide, dataURL });
      }
    }

    // Fallback: deck stores images outside <p:pic> (e.g. backgrounds) — grab raw media.
    if (!entries.length) {
      const mediaNames = Object.keys(zip.entries)
        .filter(name => /^ppt\/media\/[^/]+\.(png|jpe?g|gif|bmp)$/i.test(name))
        .sort((a, b) => slideNumber(a) - slideNumber(b));
      let i = 1;
      for (const name of mediaNames) {
        const dataURL = await mediaTargetToDataURL(zip, name);
        if (dataURL) entries.push({ slide: i++, dataURL });
      }
    }
    return entries;
  }

  function slideNumber(name) {
    const m = name.match(/(\d+)\D*$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  async function readSlideArea(zip) {
    try {
      if (!zip.entries['ppt/presentation.xml']) return 0;
      const text = await readZipEntryText(zip, 'ppt/presentation.xml');
      if (!text) return 0;
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const sz = doc.getElementsByTagName('p:sldSz')[0] || doc.getElementsByTagName('sldSz')[0];
      if (!sz) return 0;
      const cx = parseFloat(sz.getAttribute('cx') || '0');
      const cy = parseFloat(sz.getAttribute('cy') || '0');
      return cx > 0 && cy > 0 ? cx * cy : 0;
    } catch (_) {
      return 0;
    }
  }

  function parseRels(relsText) {
    const map = {};
    if (!relsText) return map;
    const doc = new DOMParser().parseFromString(relsText, 'application/xml');
    const rels = doc.getElementsByTagName('Relationship');
    for (const rel of Array.from(rels)) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) map[id] = target;
    }
    return map;
  }

  function pickSlidePictures(xmlText, relMap, slideName, minArea) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const pics = Array.from(doc.getElementsByTagName('p:pic'));
    const results = [];
    let largest = null;
    let largestArea = -1;

    for (const pic of pics) {
      const blip = pic.getElementsByTagName('a:blip')[0];
      if (!blip) continue;
      const embed = blip.getAttribute('r:embed') || blip.getAttribute('embed');
      if (!embed || !relMap[embed]) continue;
      const target = resolveRelTarget(relMap[embed], slideName);
      if (!target) continue;

      let area = 0;
      for (const ext of Array.from(pic.getElementsByTagName('a:ext'))) {
        const cx = parseFloat(ext.getAttribute('cx') || '0');
        const cy = parseFloat(ext.getAttribute('cy') || '0');
        area = Math.max(area, cx * cy);
      }
      if (area > largestArea) { largestArea = area; largest = target; }
      if (minArea && area && area < minArea) continue;
      results.push(target);
    }

    // Never drop a slide entirely: if everything was filtered out, keep its biggest picture.
    if (!results.length && largest) results.push(largest);
    return results;
  }

  function resolveRelTarget(target, slideName) {
    if (/^https?:/i.test(target)) return null;
    const baseDir = slideName.replace(/\/[^/]*$/, '/');
    const parts = (baseDir + target).split('/');
    const stack = [];
    for (const part of parts) {
      if (part === '..') stack.pop();
      else if (part !== '.' && part !== '') stack.push(part);
    }
    return stack.join('/');
  }

  async function mediaTargetToDataURL(zip, target) {
    const ext = (target.split('.').pop() || '').toLowerCase();
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', bmp: 'image/bmp',
    }[ext];
    if (!mime) return null; // emf/wmf/svg etc. can't be drawn to canvas reliably
    const bytes = await readZipEntryBytes(zip, target);
    if (!bytes) return null;
    return 'data:' + mime + ';base64,' + bytesToBase64(bytes);
  }

  // ---- Minimal ZIP reader (central directory + DEFLATE via DecompressionStream) ----

  function parseZip(buffer) {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= 0; i -= 1) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP/.pptx file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    for (let n = 0; n < count; n += 1) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = utf8Decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method, compSize, localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { dv, bytes, entries, _cache: {} };
  }

  function entryCompressedBytes(zip, name) {
    const e = zip.entries[name];
    if (!e) return null;
    const lo = e.localOffset;
    if (zip.dv.getUint32(lo, true) !== 0x04034b50) return null;
    const nameLen = zip.dv.getUint16(lo + 26, true);
    const extraLen = zip.dv.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    return { method: e.method, data: zip.bytes.subarray(start, start + e.compSize) };
  }

  async function readZipEntryBytes(zip, name) {
    const raw = entryCompressedBytes(zip, name);
    if (!raw) return null;
    if (raw.method === 0) return raw.data;
    if (raw.method === 8) return await inflateRaw(raw.data);
    throw new Error('Unsupported ZIP compression method ' + raw.method);
  }

  async function readZipEntryText(zip, name) {
    const bytes = await readZipEntryBytes(zip, name);
    return bytes ? utf8Decode(bytes) : '';
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(bytes).body.pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  function utf8Decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function createImageRecord(img, dataURL, stackIndex) {
    const rect = state.lastCanvasRect || el.canvas.getBoundingClientRect();
    const maxW = Math.max(180, rect.width * 0.42);
    const maxH = Math.max(180, rect.height * 0.42);
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const width = Math.max(60, img.width * scale);
    const height = Math.max(60, img.height * scale);
    const centerWorld = screenToWorld(rect.width / 2, rect.height / 2);
    const offset = stackIndex * (18 / Math.max(state.zoom, 0.25));

    const id = state.idCounter++;
    imageDataById.set(id, dataURL);
    return {
      id,
      dataURL,
      img,
      width,
      height,
      x: centerWorld.x - width / 2 + offset,
      y: centerWorld.y - height / 2 + offset,
      locked: false,
    };
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function loadImageFromDataURL(dataURL) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataURL;
    });
  }

function toggleSpecPanel() {
  const hidden = el.workspace.classList.toggle('panel-hidden');
  el.togglePanelBtn.textContent = hidden ? 'Show Panel' : 'Hide Panel';
  el.togglePanelBtn.classList.toggle('active', hidden);
  // Layout changed — recompute canvas size and keep current view.
  resizeCanvas();
}

function toggleLabels() {
  state.showLabels = !state.showLabels;
  // If a label editor is open and labels are being hidden, close it first so
  // the floating input doesn't linger over a now-invisible callout.
  if (!state.showLabels && state.editingLabelId != null) {
    cancelLabelEditor();
  }
  updateUI();
  requestRender();
}

function fitSelectionOrAll() {
  const selectedImage = getSelectedImage();
  if (selectedImage) {
    fitBoundsToViewport(getImageBounds(selectedImage));
    return;
  }
  fitImagesToBoard();
}

function fitImagesToBoard() {
  if (!state.images.length) {
    resetViewport();
    return;
  }
  fitBoundsToViewport(getImagesBounds());
}

function fitBoundsToViewport(bounds) {
  const rect = getViewportRect();
  if (!bounds || rect.width <= 0 || rect.height <= 0) {
    resetViewport();
    return;
  }

  const availW = Math.max(80, rect.width - IMAGE_PADDING * 2);
  const availH = Math.max(80, rect.height - IMAGE_PADDING * 2);
  const zoom = clamp(Math.min(availW / bounds.width, availH / bounds.height), MIN_ZOOM, MAX_ZOOM);
  state.zoom = zoom;
  state.panX = rect.width / 2 - (bounds.x + bounds.width / 2) * zoom;
  state.panY = rect.height / 2 - (bounds.y + bounds.height / 2) * zoom;
  updateUI();
  requestRender();
}

function resetViewport() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateUI();
  requestRender();
}

function getImagesBounds() {
    const first = state.images[0];
    let minX = first.x;
    let minY = first.y;
    let maxX = first.x + first.width;
    let maxY = first.y + first.height;
    for (let i = 1; i < state.images.length; i += 1) {
      const image = state.images[i];
      minX = Math.min(minX, image.x);
      minY = Math.min(minY, image.y);
      maxX = Math.max(maxX, image.x + image.width);
      maxY = Math.max(maxY, image.y + image.height);
    }
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

function getImageBounds(image) {
  return {
    x: image.x,
    y: image.y,
    width: Math.max(1, image.width),
    height: Math.max(1, image.height),
  };
}

// Annotations whose line midpoint sits within the image are treated as part of
// that sketch, so dragging the image moves its callouts as one group.
function getAnnotationsOnImage(image) {
  const bounds = getImageBounds(image);
  return state.annotations.filter(ann => {
    const cx = (ann.start.x + ann.end.x) / 2;
    const cy = (ann.start.y + ann.end.y) / 2;
    return cx >= bounds.x && cx <= bounds.x + bounds.width
      && cy >= bounds.y && cy <= bounds.y + bounds.height;
  });
}

function setSelection(kind, id) {
    state.selection = kind && id != null ? { kind, id } : { kind: null, id: null };
    if (kind === 'annotation') {
      const ann = getAnnotationById(id);
      if (ann) {
        state.drawStyle = ann.style || state.drawStyle;
        state.drawColor = normalizeColorKey(ann.color);
        state.arrowType = getArrowType(ann);
      }
    }
    updateUI();
    requestRender();
  }

  function clearSelection() {
    setSelection(null, null);
  }

  function getSelectedAnnotation() {
    return state.selection.kind === 'annotation'
      ? state.annotations.find(a => a.id === state.selection.id) || null
      : null;
  }

  function getSelectedImage() {
    return state.selection.kind === 'image'
      ? state.images.find(image => image.id === state.selection.id) || null
      : null;
  }

  function toggleSelectedImageLock() {
    const image = getSelectedImage();
    if (!image) {
      showToast('Select an image first.');
      return;
    }
    image.locked = !image.locked;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast(image.locked
      ? 'Image locked. Lines and annotations are unaffected.'
      : 'Image unlocked.');
  }

  function onMouseDown(e) {
    const isPanButton = state.spacePan || e.button === 1 || e.button === 2;
    if (isPanButton) {
      startPanInteraction(e);
      return;
    }
    if (e.button !== 0) return;

    const screen = getMousePos(e);
    const world = screenToWorld(screen.x, screen.y);

    // Auto Mode: only drafts + anchors are interactive. Project annotations
    // are locked, and tool creation / erasing is disabled (see updateUI).
    if (state.appMode === 'auto') {
      // Anchors always win: a TD must be able to grab a wrong anchor even
      // if a draft line crosses through it.
      const anchorHit = hitTestAnchors(world);
      if (anchorHit) {
        state.autoMode.anchorSelectedId = anchorHit.id;
        // Clear any draft selection so the spec panel stops highlighting it.
        if (state.selection.kind === 'draft') {
          state.selection = { kind: null, id: null };
        }
        startAnchorDrag(anchorHit.id, world);
        updateUI();
        requestRender();
        return;
      }

      const selectedDraft = getSelectedDraft();
      const draftHandleHit = selectedDraft && !isReviewOnlyDraft(selectedDraft)
        ? hitTestSelectedHandles(world, selectedDraft) : null;
      if (draftHandleHit) {
        startHandleDrag(selectedDraft.id, draftHandleHit.part, world);
        return;
      }
      const draftHit = hitTestAutoDraftAnnotations(world);
      if (draftHit) {
        setSelection('draft', draftHit.id);
        if (draftHit.part === 'label') {
          startLabelDrag(draftHit.id, world);
        } else {
          startAnnotationDrag(draftHit.id, world);
        }
        return;
      }
      // Empty space — drop any current selection (draft or anchor).
      if (state.selection.kind === 'draft' || state.autoMode.anchorSelectedId != null) {
        state.autoMode.anchorSelectedId = null;
        if (state.selection.kind === 'draft') {
          state.selection = { kind: null, id: null };
        }
        updateUI();
        requestRender();
      }
      return;
    }

    if (state.tool === 'straight' || state.tool === 'curved') {
      handleDrawToolClick(world);
      return;
    }

    if (state.tool === 'eraser') {
      beginEraseStroke(world);
      return;
    }

    const selectedAnnotation = getSelectedAnnotation();
    const handleHit = selectedAnnotation ? hitTestSelectedHandles(world, selectedAnnotation) : null;
    if (handleHit) {
      startHandleDrag(selectedAnnotation.id, handleHit.part, world);
      return;
    }

    const selectedImage = getSelectedImage();
    const imageHandleHit = selectedImage && !selectedImage.locked
      ? hitTestSelectedImageHandles(world, selectedImage) : null;
    if (imageHandleHit) {
      startImageResize(selectedImage.id, imageHandleHit.corner);
      return;
    }

    const annotationHit = hitTestAnnotations(world);
    if (annotationHit) {
      setSelection('annotation', annotationHit.id);
      if (annotationHit.part === 'label') {
        startLabelDrag(annotationHit.id, world);
      } else {
        startAnnotationDrag(annotationHit.id, world);
      }
      return;
    }

    const imageHit = hitTestImages(world);
    if (imageHit) {
      setSelection('image', imageHit.id);
      const hitImage = getImageById(imageHit.id);
      if (hitImage && !hitImage.locked) {
        startImageDrag(imageHit.id, world);
      }
      return;
    }

    if (state.selection.kind != null) {
      clearSelection();
    }
  }

  function onMouseMove(e) {
    const screen = getMousePos(e);
    const world = screenToWorld(screen.x, screen.y);

    if (state.drawSession) {
      state.drawSession.current = world;
      requestRender();
    }

    if (state.eraseSession) {
      appendErasePoint(world);
    }

    const interaction = state.interaction;
    if (!interaction) return;

    if (interaction.type === 'pan') {
      const dx = screen.x - interaction.startScreen.x;
      const dy = screen.y - interaction.startScreen.y;
      state.panX = interaction.startPan.x + dx;
      state.panY = interaction.startPan.y + dy;
      updateUI();
      requestRender();
      return;
    }

    if (interaction.type === 'drag-annotation') {
      const ann = getAnnotationById(interaction.id);
      if (!ann) return;
      const dx = world.x - interaction.prevWorld.x;
      const dy = world.y - interaction.prevWorld.y;
      if (dx || dy) {
        moveAnnotation(ann, dx, dy);
        if (isAutoDraft(ann)) markDraftTouchedByTD(ann);
        interaction.changed = true;
        interaction.prevWorld = world;
        requestRender();
      }
      return;
    }

    if (interaction.type === 'drag-label') {
      const ann = getAnnotationById(interaction.id);
      if (!ann || !ann.label) return;
      const dx = world.x - interaction.prevWorld.x;
      const dy = world.y - interaction.prevWorld.y;
      if (dx || dy) {
        ann.label.x += dx;
        ann.label.y += dy;
        ann.labelManual = true;
        if (isAutoDraft(ann) && state.appMode === 'auto') markDraftTouchedByTD(ann);
        interaction.changed = true;
        interaction.prevWorld = world;
        requestRender();
      }
      return;
    }

    if (interaction.type === 'drag-handle') {
      const ann = getAnnotationById(interaction.id);
      if (!ann) return;
      dragHandle(ann, interaction.part, world, interaction.prevWorld);
      if (isAutoDraft(ann) && state.appMode === 'auto') markDraftTouchedByTD(ann);
      interaction.changed = true;
      interaction.prevWorld = world;
      requestRender();
      return;
    }

    if (interaction.type === 'drag-image') {
      const image = getImageById(interaction.id);
      if (!image) return;
      const dx = world.x - interaction.prevWorld.x;
      const dy = world.y - interaction.prevWorld.y;
      if (dx || dy) {
        image.x += dx;
        image.y += dy;
        if (interaction.groupedAnnotationIds) {
          for (const annId of interaction.groupedAnnotationIds) {
            const ann = getAnnotationById(annId);
            if (ann) moveAnnotation(ann, dx, dy);
          }
        }
        interaction.changed = true;
        interaction.prevWorld = world;
        requestRender();
      }
      return;
    }

    if (interaction.type === 'drag-image-resize') {
      const image = getImageById(interaction.id);
      if (!image) return;
      resizeImageFromCorner(image, interaction.corner, interaction.anchor, interaction.aspect, world);
      interaction.changed = true;
      interaction.prevWorld = world;
      requestRender();
      return;
    }

    if (interaction.type === 'drag-anchor') {
      const anchor = getAnchorById(interaction.id);
      if (!anchor) return;
      const image = getImageById(anchor.sourceImageId);
      if (!image || !image.width || !image.height) return;
      // Convert world delta into the source image's normalized space.
      const dx = (world.x - interaction.prevWorld.x) / image.width;
      const dy = (world.y - interaction.prevWorld.y) / image.height;
      if (dx || dy) {
        anchor.x = clamp01(anchor.x + dx);
        anchor.y = clamp01(anchor.y + dy);
        anchor.autoFilled = false;
        interaction.changed = true;
        interaction.prevWorld = world;
        requestRender();
      }
    }
  }

  function onMouseUp() {
    if (state.eraseSession) {
      commitEraseStroke();
    }

    const interaction = state.interaction;
    if (!interaction) return;

    document.body.classList.remove('grabbing');

    if (interaction.type !== 'pan' && interaction.changed) {
      const before = interaction.beforeFingerprint;
      const after = snapshotFingerprint(makeSnapshot());
      if (before !== after) {
        // Learning-loop capture: log the (origin → final) anchor residual
        // exactly once per drag commit. We do this here, not on every
        // mousemove, so micro-jitter and aborted drags never reach the
        // bucket. recordAnchorResidual self-filters sub-1px deltas.
        if (interaction.type === 'drag-anchor' && interaction.learnOrigin) {
          const anchor = getAnchorById(interaction.id);
          if (anchor && anchor.kind === interaction.learnOrigin.kind) {
            recordAnchorResidual(
              anchor.kind,
              anchor.x - interaction.learnOrigin.x,
              anchor.y - interaction.learnOrigin.y
            );
          }
        }
        pushHistoryIfChanged();
      }
    }

    state.interaction = null;
  }

function onWheel(e) {
  e.preventDefault();

  if (e.shiftKey) {
    state.panX -= normalizeWheelDelta(e) * 0.45;
    updateUI();
    requestRender();
    return;
  }

  const mouse = getMousePos(e);
  const sensitivity = e.altKey ? PRECISE_ZOOM_SENSITIVITY : ZOOM_SENSITIVITY;
  const factor = Math.exp(-normalizeWheelDelta(e) * sensitivity);
  zoomAtScreenPoint(state.zoom * factor, mouse.x, mouse.y);
}

  function onKeyDown(e) {
    const target = e.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    // Meaning popover owns the keyboard while open. ESC closes it (when
    // no input is focused — the inline "Other…" input handles its own
    // ESC). Every other non-field key is swallowed so canvas shortcuts
    // (S/B/0/F/etc.) don't fire under the TD while they pick a meaning.
    if (pendingMeaningEval) {
      if (e.key === 'Escape' && !inField) {
        e.preventDefault();
        closePomMeaningPopover();
        return;
      }
      if (inField) return;       // popover's own input handles its keys
      return;                    // swallow everything else
    }

    if (inField) return;
    // A modal (Help, Set Scale, PPTX picker) is open — let it own the keyboard.
    if (document.querySelector('.picker-overlay')) {
      return;
    }
    const isMeta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (e.code === 'Space' && !state.spacePan) {
      state.spacePan = true;
      document.body.classList.add('space-pan');
      e.preventDefault();
    }

    if (isMeta && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      void undo();
      return;
    }
    if (isMeta && ((key === 'z' && e.shiftKey) || key === 'y')) {
      e.preventDefault();
      void redo();
      return;
    }

    if ((isMeta && key === '0') || (!isMeta && key === 'f')) {
      e.preventDefault();
      fitSelectionOrAll();
      return;
    }

    if (!isMeta && key === 's') {
      e.preventDefault();
      setTool('select');
      return;
    }

    // In Auto Mode, manual creation/eraser shortcuts must not steal the
    // tool away from select. The project annotations are locked.
    if (state.appMode !== 'auto') {
      if (!isMeta && (key === '0' || key === 'l')) {
        e.preventDefault();
        setTool('straight');
        return;
      }

      if (!isMeta && (key === 'b' || key === 'c')) {
        e.preventDefault();
        setTool('curved');
        return;
      }

      if (!isMeta && key === 'e' && state.images.length > 0) {
        e.preventDefault();
        setTool('eraser');
        return;
      }
    }

    if (!isMeta && key === 'n') {
      e.preventDefault();
      toggleLabels();
      return;
    }

    if (!isMeta && state.tool === 'eraser' && (key === '[' || key === ']')) {
      e.preventDefault();
      const factor = key === ']' ? 1.18 : 1 / 1.18;
      state.brushSize = Math.max(4, Math.min(200, Math.round(state.brushSize * factor)));
      showToast('Brush size: ' + state.brushSize + ' px');
      updateUI();
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.kind != null) {
      // In Auto Mode, project annotations are locked; Delete on a draft also
      // does nothing (use Discard Drafts or Mark Review-Only instead).
      if (state.appMode === 'auto') return;
      e.preventDefault();
      deleteSelected();
      return;
    }

    if (e.key === 'Escape') {
      if (!el.stitchesMenu.hidden) {
        closeLineStyleMenu();
      } else if (state.drawSession) {
        state.drawSession = null;
        state.tool = 'select';
        showToast('Drawing canceled.');
        updateUI();
        requestRender();
      } else if (state.eraseSession) {
        state.eraseSession = null;
        showToast('Erase canceled.');
        updateUI();
        requestRender();
      } else if (state.tool === 'straight' || state.tool === 'curved' || state.tool === 'eraser') {
        setTool('select');
      } else if (state.selection.kind != null) {
        clearSelection();
      }
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') {
      state.spacePan = false;
      document.body.classList.remove('space-pan');
      document.body.classList.remove('grabbing');
    }
  }

  function startPanInteraction(e) {
    const startScreen = getMousePos(e);
    state.interaction = {
      type: 'pan',
      startScreen,
      startPan: { x: state.panX, y: state.panY },
      changed: false,
    };
    document.body.classList.add('grabbing');
  }

function beginTrackedInteraction(type, payload) {
  state.interaction = {
    type,
    changed: false,
    beforeFingerprint: snapshotFingerprint(makeSnapshot()),
    ...payload,
  };
}

function startAnnotationDrag(id, world) {
  beginTrackedInteraction('drag-annotation', { id, prevWorld: world });
}

function startLabelDrag(id, world) {
  beginTrackedInteraction('drag-label', { id, prevWorld: world });
}

function startHandleDrag(id, part, world) {
  beginTrackedInteraction('drag-handle', { id, part, prevWorld: world });
}

function startImageDrag(id, world) {
  const image = getImageById(id);
  const groupedAnnotationIds = image ? getAnnotationsOnImage(image).map(ann => ann.id) : [];
  beginTrackedInteraction('drag-image', { id, prevWorld: world, groupedAnnotationIds });
}

function startImageResize(id, corner) {
  const image = getImageById(id);
  if (!image) return;
  beginTrackedInteraction('drag-image-resize', {
    id,
    corner,
    anchor: getOppositeImageCorner(image, corner),
    aspect: image.width / Math.max(1, image.height),
  });
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

    const ann = createCurvedAnnotation(start, end, drawSettings.style, drawSettings.color, drawSettings.arrowType, drawSettings.lineWidth);
    state.annotations.push(ann);
    state.selection = { kind: 'annotation', id: ann.id };
    state.nextSequence += 1;
    state.drawSession = null;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
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

  function createStraightAnnotation(start, end, style, color = 'red', arrowType = 'double', lineWidth = DEFAULT_LINE_WIDTH) {
    const id = state.idCounter++;
    const label = computeDefaultLabelPosition({
      type: 'straight',
      start,
      end,
    });
    return {
      id,
      seq: state.nextSequence,
      type: 'straight',
      style,
      color,
      arrowType,
      lineWidth: normalizeLineWidth(lineWidth),
      start: clonePoint(start),
      end: clonePoint(end),
      control1: null,
      control2: null,
      label,
      labelManual: false,
      text: null,
      value: null,
    };
  }

  function createCurvedAnnotation(start, end, style, color = 'red', arrowType = 'double', lineWidth = DEFAULT_LINE_WIDTH) {
    const id = state.idCounter++;
    const controls = makeNaturalCurveControls(start, end);
    const label = computeDefaultLabelPosition({
      type: 'curved',
      start,
      end,
      control1: controls.control1,
      control2: controls.control2,
    });
    return {
      id,
      seq: state.nextSequence,
      type: 'curved',
      style,
      color,
      arrowType,
      lineWidth: normalizeLineWidth(lineWidth),
      start: clonePoint(start),
      end: clonePoint(end),
      control1: controls.control1,
      control2: controls.control2,
      label,
      labelManual: false,
      text: null,
      value: null,
    };
  }

  function makeNaturalCurveControls(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;
    const offset = clamp(len * 0.16, 26 / state.zoom, 82 / state.zoom);
    return {
      control1: {
        x: start.x + dx / 3 + nx * offset,
        y: start.y + dy / 3 + ny * offset
      },
      control2: {
        x: start.x + (dx * 2) / 3 + nx * offset,
        y: start.y + (dy * 2) / 3 + ny * offset
      }
    };
  }

  function computeDefaultLabelPosition(annLike) {
    if (annLike.type === 'straight') {
      const mid = midpoint(annLike.start, annLike.end);
      const angle = Math.atan2(annLike.end.y - annLike.start.y, annLike.end.x - annLike.start.x);
      const offset = 18 / state.zoom;
      return {
        x: mid.x + Math.cos(angle - Math.PI / 2) * offset,
        y: mid.y + Math.sin(angle - Math.PI / 2) * offset
      };
    }
    const point = bezierPoint(annLike.start, annLike.control1, annLike.control2, annLike.end, 0.5);
    const tangent = bezierTangent(annLike.start, annLike.control1, annLike.control2, annLike.end, 0.5);
    const angle = Math.atan2(tangent.y, tangent.x);
    const offset = 20 / state.zoom;
    return {
      x: point.x + Math.cos(angle - Math.PI / 2) * offset,
      y: point.y + Math.sin(angle - Math.PI / 2) * offset
    };
  }

  // Numbered callouts cluster at the bra center-front: POMs 1, 5, 6, 7, 8 all
  // fall in the same vertical strip. Nudge labels apart along each line's
  // perpendicular so the numbers stay readable. Skips manually-placed labels.
  function nudgeAutoLabelsToAvoidCollisions(anns) {
    if (!anns || anns.length < 2) return;
    const items = anns.filter(a => a && a.label && !a.labelManual && a.start && a.end);
    if (items.length < 2) return;
    const minGap = 22;
    const perp = items.map((a) => {
      let dx, dy;
      if (a.type === 'curved' && a.control1 && a.control2) {
        const t = bezierTangent(a.start, a.control1, a.control2, a.end, 0.5);
        dx = t.x; dy = t.y;
      } else {
        dx = a.end.x - a.start.x;
        dy = a.end.y - a.start.y;
      }
      const len = Math.hypot(dx, dy) || 1;
      return { x: -dy / len, y: dx / len };
    });
    for (let iter = 0; iter < 24; iter += 1) {
      let moved = false;
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const a = items[i].label, b = items[j].label;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d >= minGap) continue;
          const step = (minGap - d) * 0.55;
          a.x += perp[i].x * step;
          a.y += perp[i].y * step;
          b.x -= perp[j].x * step;
          b.y -= perp[j].y * step;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  function dragHandle(ann, part, world, prevWorld) {
    const dx = world.x - prevWorld.x;
    const dy = world.y - prevWorld.y;

    if (part === 'start') {
      ann.start = clonePoint(world);
      if (ann.type === 'curved' && ann.control1) {
        ann.control1.x += dx;
        ann.control1.y += dy;
      }
    } else if (part === 'end') {
      ann.end = clonePoint(world);
      if (ann.type === 'curved' && ann.control2) {
        ann.control2.x += dx;
        ann.control2.y += dy;
      }
    } else if (part === 'control1' && ann.control1) {
      ann.control1 = clonePoint(world);
    } else if (part === 'control2' && ann.control2) {
      ann.control2 = clonePoint(world);
    }

    if (!ann.labelManual) {
      ann.label = computeDefaultLabelPosition(ann);
    }
  }

  function moveAnnotation(ann, dx, dy) {
    ann.start.x += dx; ann.start.y += dy;
    ann.end.x += dx; ann.end.y += dy;
    if (ann.control1) {
      ann.control1.x += dx; ann.control1.y += dy;
    }
    if (ann.control2) {
      ann.control2.x += dx; ann.control2.y += dy;
    }
    ann.label.x += dx; ann.label.y += dy;
  }

  function normalizeColorKey(color) {
    if (LINE_COLORS[color]) return color;
    const found = Object.entries(LINE_COLORS).find(([, value]) => value.toLowerCase() === String(color || '').toLowerCase());
    return found ? found[0] : 'red';
  }

  function getAnnotationColor(ann) {
    const key = normalizeColorKey(ann?.color);
    return LINE_COLORS[key] || LINE_COLOR;
  }

  // The board has two modes, driven entirely by the active Stitches selection.
  // Plain/Dashed keep measurement (POM) mode; the three true stitch types put
  // the whole board into Stitch (construction) mode.
  function isStitchMode() {
    return state.drawStyle === 'zigzag' || state.drawStyle === 'cover' || state.drawStyle === 'bartack';
  }

  // Callout numbers are always hidden in Stitch mode; in POM mode they honor
  // the manual Hide/Show Numbers toggle.
  function labelsVisible() {
    return state.showLabels && !isStitchMode();
  }

  // Certain POMs are always drawn a fixed way regardless of stored style.
  // POM 2 (1/2 chest) and POM 4 (cup width) are extension measures: dashed + single arrow.
  const FORCED_POM_STYLE = {
    '2': { style: 'dashed', arrowType: 'single' },
    '4': { style: 'dashed', arrowType: 'single' },
  };

  function forcedStyleFor(ann) {
    // POM 2 & 4 are only forced to dashed/single in measurement (POM) mode.
    if (isStitchMode()) return null;
    return FORCED_POM_STYLE[getLabelText(ann)] || null;
  }

  function getLineStyle(ann) {
    const forced = forcedStyleFor(ann);
    if (forced) return forced.style;
    return normalizeLineStyle(ann?.style);
  }

  // True when start/end land in different detected view boxes (front vs back).
  // POM 14 (strap curve) and POM 16 (apex distance) commonly span the gap
  // between sketches; rendering them dashed prevents misreading the line as
  // measuring something inside a single view.
  function annotationCrossesViews(ann) {
    if (!ann || !ann.sourceImageId || !ann.start || !ann.end) return false;
    const det = state.autoMode && state.autoMode.detection;
    if (!det || det.sourceImageId !== ann.sourceImageId) return false;
    const boxes = det.viewBoxes;
    if (!Array.isArray(boxes) || boxes.length < 2) return false;
    const image = getImageById(ann.sourceImageId);
    if (!image || !image.width || !image.height) return false;
    const findViewIdx = (p) => {
      const nx = (p.x - image.x) / image.width;
      const ny = (p.y - image.y) / image.height;
      let best = -1;
      let bestArea = Infinity;
      for (let i = 0; i < boxes.length; i += 1) {
        const b = boxes[i];
        if (b == null) continue;
        if (nx >= b.x && nx <= b.x + b.width && ny >= b.y && ny <= b.y + b.height) {
          const area = b.width * b.height;
          if (area < bestArea) { bestArea = area; best = i; }
        }
      }
      return best;
    };
    const a = findViewIdx(ann.start);
    const b = findViewIdx(ann.end);
    if (a < 0 || b < 0) return false;
    return a !== b;
  }

  function normalizeLineStyle(style) {
    return ['solid', 'dashed', 'zigzag', 'cover', 'bartack'].includes(style) ? style : 'solid';
  }

  function updateLineStyleControl(activeStyle) {
    const style = normalizeLineStyle(activeStyle);
    el.stitchesBtnLabel.textContent = 'Stitches: ' + lineStyleLabel(style);
    el.stitchesBtn.classList.toggle('active', style !== 'solid');
    el.styleOptionBtns.forEach((button) => {
      button.classList.toggle('active', button.dataset.style === style);
    });
  }

  function lineStyleLabel(style) {
    if (style === 'dashed') return 'Dashed';
    if (style === 'zigzag') return 'Zigzag';
    if (style === 'cover') return 'Cover';
    if (style === 'bartack') return 'Bartack';
    return 'Plain';
  }

  function getArrowType(ann) {
    const forced = forcedStyleFor(ann);
    if (forced) return forced.arrowType;
    if (ann?.arrowType === 'single' || ann?.arrowType === 'double' || ann?.arrowType === 'none') {
      return ann.arrowType;
    }
    return ann?.style === 'solid' ? 'double' : 'single';
  }

  function normalizeLineWidth(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_LINE_WIDTH;
    return clamp(n, MIN_LINE_WIDTH, MAX_LINE_WIDTH);
  }

  function getLineWidth(ann) {
    return normalizeLineWidth(ann?.lineWidth);
  }

  function getActiveLineWidth() {
    const selectedAnnotation = getSelectedAnnotation();
    return selectedAnnotation ? getLineWidth(selectedAnnotation) : normalizeLineWidth(state.lineWidth);
  }

  function formatLineWidth(value) {
    return String(Math.round(normalizeLineWidth(value) * 10) / 10).replace(/\.0$/, '');
  }

  function getLabelText(ann) {
    if (ann && ann.text != null && String(ann.text).trim() !== '') return String(ann.text);
    return String(ann.seq);
  }

  function lineLength(ann) {
    if (ann.type === 'straight') return distance(ann.start, ann.end);
    let total = 0;
    let prev = ann.start;
    for (let i = 1; i <= BEZIER_SAMPLES; i += 1) {
      const cur = bezierPoint(ann.start, ann.control1, ann.control2, ann.end, i / BEZIER_SAMPLES);
      total += distance(prev, cur);
      prev = cur;
    }
    return total;
  }

  function getMeasuredValue(ann) {
    if (ann.value != null && String(ann.value).trim() !== '') return String(ann.value);
    if (state.calibration.unitsPerPx != null) {
      const real = lineLength(ann) * state.calibration.unitsPerPx;
      return formatMeasure(real) + ' ' + state.calibration.unit;
    }
    return '';
  }

  function formatMeasure(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  // Map a callout label ("8", "1,2") to POM standard info. Joins descriptions for
  // multi-POM labels; returns a reference value only when a single POM is matched.
  function getPomInfo(labelText) {
    const text = String(labelText == null ? '' : labelText).trim();
    if (!text) return { desc: '', refL: null };
    const nums = text.split(/[,\s]+/).filter(Boolean);
    const descs = [];
    for (const n of nums) {
      const info = POM_TEMPLATE[n];
      if (info) descs.push(info.desc);
    }
    const single = nums.length === 1 && POM_TEMPLATE[nums[0]] ? POM_TEMPLATE[nums[0]] : null;
    return { desc: descs.join('; '), refL: single ? single.refL : null };
  }

  function getAnnotationById(id) {
    const hit = state.annotations.find(a => a.id === id);
    if (hit) return hit;
    // Draft annotations live outside state.annotations but share the same id
    // space, so drag/handle interaction handlers can look them up too.
    const draft = state.autoMode.draftAnnotations.find(a => a.id === id);
    return draft || null;
  }

  function getDraftById(id) {
    return state.autoMode.draftAnnotations.find(a => a.id === id) || null;
  }

  function isAutoDraft(ann) {
    return !!(ann && ann.auto === true && ann.sourceMode === 'auto-mode' && ann.autoRunId);
  }

  function isReviewOnlyDraft(ann) {
    return !!(ann && ann.drawability === 'REVIEW_ONLY');
  }

  function createUniqueAnnotationId() {
    return state.idCounter++;
  }

  function getImageById(id) {
    return state.images.find(image => image.id === id) || null;
  }

  function deleteSelected() {
    if (state.selection.kind == null) return;

    if (state.selection.kind === 'annotation') {
      const before = state.annotations.length;
      state.annotations = state.annotations.filter(a => a.id !== state.selection.id);
      if (state.annotations.length === before) return;
      renumberAnnotations();
    } else if (state.selection.kind === 'image') {
      const target = getImageById(state.selection.id);
      if (target && target.locked) {
        showToast('Image is locked. Click Unlock first.');
        return;
      }
      const before = state.images.length;
      const deletedId = state.selection.id;
      state.images = state.images.filter(image => image.id !== deletedId);
      if (state.images.length === before) return;
      state.eraseStrokes = state.eraseStrokes.filter(stroke => stroke.imageId !== deletedId);
    }

    state.selection = { kind: null, id: null };
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  function clearAllAnnotations() {
    if (!state.annotations.length) return;
    state.annotations = [];
    state.nextSequence = 1;
    if (state.selection.kind === 'annotation') {
      state.selection = { kind: null, id: null };
    }
    state.drawSession = null;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  function renumberAnnotations() {
    state.annotations.forEach((ann, index) => {
      ann.seq = index + 1;
    });
    state.nextSequence = state.annotations.length + 1;
  }
