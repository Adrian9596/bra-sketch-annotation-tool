// Open a .json project file: file-input handling, then restore it onto the
// board. Saving is project-save.js.
// Source part for app.js. Run `npm run build` after editing.
//
// loadProject restores a saved snapshot, including image pixel data, and
// seeds a fresh history stack. Unapplied Auto Mode drafts are never
// silently dropped; the open flow prompts the TD to apply, discard, or
// cancel before replacing the board.

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

    if ((typeof hasUnsavedWork === 'function' ? hasUnsavedWork() : (state.annotations.length || state.images.length)) &&
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
    // Silence autosave while we rewrite state in bulk; any edit after
    // load completes will re-arm it via pushHistoryIfChanged. Wrapped
    // in try/finally so autosave always resumes even on a failed load.
    if (typeof suspendAutosave === 'function') suspendAutosave();
    try {
      const s = project.state;

      state.annotations = clone(s.annotations || []);
      state.annotations.forEach(ensureCurveControls);
      // US-095 additive migration: pre-shape projects omit this key.
      state.graphics = normalizeBoardGraphics(s.graphics || []);
      state.graphicEdit = null;
      state.eraseStrokes = clone(s.eraseStrokes || []);
      // US-092. normalizeNote drops a record that could not be placed rather
      // than failing the whole load, and fills in fields a file written by an
      // older build would not carry.
      state.notes = Array.isArray(s.notes)
        ? s.notes.map(normalizeNote).filter(Boolean)
        : [];
      state.brushSize = s.brushSize || 24;
      state.showLabels = s.showLabels !== false;
      state.calibration = s.calibration || { unitsPerPx: null, unit: 'in' };
      state.nextSequence = s.nextSequence || (state.annotations.length + 1);
      state.drawStyle = s.drawStyle || 'solid';
      state.drawColor = s.drawColor || 'red';
      state.arrowType = s.arrowType || 'double';
      state.lineWidth = normalizeLineWidth(s.lineWidth);
      // Additive like lineWidth: a file saved before this control existed has
      // no key, and normalizeNoteFontSize's own NaN fallback covers it.
      state.noteFontSize = normalizeNoteFontSize(s.noteFontSize);
      state.tool = 'select';
      state.selection = { kind: null, id: null };
      state.drawSession = null;
      state.eraseSession = null;
      state.interaction = null;
      state.editingLabelId = null;
      // Old projects load normally; unapplied drafts are not persisted.
      // Reopen behavior: a project that contains applied lines opens in
      // Manual Mode, ready to edit. An empty or image-only project stays
      // Auto-first so detection can run right away.
      state.appMode = (state.annotations.length > 0 || state.graphics.length > 0 || state.notes.length > 0) ? 'manual' : 'auto';
      state.autoMode = makeInitialAutoModeState();
      state.hiddenAnnIds = [];
      state.hiddenDraftIds = [];
      document.body.classList.toggle('app-auto', state.appMode === 'auto');
      document.body.classList.remove('tool-eraser');
      el.labelEditor.style.display = 'none';
      discardNoteEditorSession();

      imageDataById.clear();
      // Autosave's quota-fallback strips image bitmap data (dataURL: null).
      // Silently skip those entries so restore does not throw — the TD
      // has to re-import the image, but the annotation work is intact.
      const imageMetas = (s.images || []).filter((meta) => meta && meta.dataURL);
      state.images = await Promise.all(imageMetas.map(async (meta) => {
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
      state.pomSpecs = (s.pomSpecs && typeof s.pomSpecs === 'object') ? clone(s.pomSpecs) : {};
      // THE single v1→v2 grading migration point: saved files and autosave
      // restores both funnel through loadProject. Legacy s.depthRules folds
      // into the v2 container's depthOffsets losslessly.
      state.gradeRules = migrateGradeRulesV2(s.gradeRules, s.depthRules);
      state.customPoms = Array.isArray(s.customPoms) ? clone(s.customPoms) : [];
      state.deletedPomKeys = Array.isArray(s.deletedPomKeys) ? clone(s.deletedPomKeys) : [];
      state.sizeSelection = (s.sizeSelection && typeof s.sizeSelection === 'object')
        ? clone(s.sizeSelection) : null;
      // US-080: mpLoadProjectState pulls the sketch bytes out into the module
      // map and leaves state.mainPage byte-free, the way BOM images load.
      if (typeof mpLoadProjectState === 'function') mpLoadProjectState(s.mainPage);
      else {
        state.mainPage = (s.mainPage && typeof s.mainPage === 'object')
          ? clone(s.mainPage) : null;
        if (typeof ensureMainPage === 'function') ensureMainPage();
      }
      if (typeof renderMainPage === 'function') renderMainPage();
      if (typeof ccLoadProjectState === 'function') await ccLoadProjectState(s.construction, s.images);
      else {
        state.construction = (s.construction && typeof s.construction === 'object')
          ? clone(s.construction) : null;
        if (typeof ensureConstruction === 'function') ensureConstruction(s.images);
      }
      if (typeof renderConstruction === 'function') renderConstruction();
      if (typeof bmLoadProjectState === 'function') await bmLoadProjectState(s.bom);
      else {
        state.bom = (s.bom && typeof s.bom === 'object') ? clone(s.bom) : null;
        if (typeof ensureBom === 'function') ensureBom();
      }
      if (typeof renderBom === 'function') renderBom();
      state.preview = (s.preview && typeof s.preview === 'object') ? clone(s.preview) : null;
      if (typeof ensurePreviewPage === 'function') ensurePreviewPage();

      // Images are in place now, so the Auto status chip can resolve
      // ready/idle correctly for the reopened board.
      ensureAutoModeStatus();
      seedHistory();
      updateUI();
      requestRender();
      // Loaded state supersedes anything in the autosave slot; drop the
      // stale copy so a next-launch restore prompt does not resurface it.
      if (typeof clearAutosave === 'function') clearAutosave();
    } finally {
      if (typeof resumeAutosave === 'function') resumeAutosave();
    }
  }
