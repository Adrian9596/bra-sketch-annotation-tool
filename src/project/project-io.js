// Save and open .json project files.
// Source part for app.js. Run `npm run build` after editing.
//
// buildProjectSnapshot serializes board state into the on-disk project
// format. loadProject restores that snapshot, including image pixel data,
// and seeds a fresh history stack. Unapplied Auto Mode drafts are never
// persisted; the open/save flow prompts the TD to apply, discard, or
// cancel before replacing the board.

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
        pomSpecs: clone(state.pomSpecs || {}),
        // v2 container carries steps + per-size deltas + depthOffsets (the
        // former depthRules field); old files still load via migration.
        gradeRules: clone(state.gradeRules || {}),
        customPoms: clone(state.customPoms || []),
        deletedPomKeys: clone(state.deletedPomKeys || []),
        sizeSelection: state.sizeSelection ? clone(state.sizeSelection) : null,
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

    // Phase 2: style-evidence capture. Offer to remember TD-edited Auto
    // lines for the current style. The dialog only opens when there is
    // something to remember; an empty candidate list saves immediately.
    const styleForEvidence = currentStyleId();
    const candidates = (typeof collectStyleEvidenceCandidates === 'function')
      ? collectStyleEvidenceCandidates(styleForEvidence)
      : [];

    if (candidates.length === 0) {
      writeProjectFile();
      return;
    }

    openSaveEvidenceDialog({ styleId: styleForEvidence, candidates }).then(choice => {
      if (!choice || choice.action === 'cancel') return;
      if (choice.action === 'save-with-evidence') {
        // Re-read currentStyleId so a style code typed inside the dialog
        // (which already wrote state.styleId on accept) takes effect on
        // the commit. Falls back to the original styleId for callers
        // that don't expose the inline input.
        const targetStyle = currentStyleId();
        const written = commitStyleEvidenceCandidates(targetStyle, candidates);
        if (written > 0) {
          showToast('Saved ' + written + ' style evidence record'
            + (written === 1 ? '' : 's') + ' for this style.');
        }
      }
      writeProjectFile();
    });
  }

  function writeProjectFile() {
    const project = buildProjectSnapshot();
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    downloadBlob(blob, makeProjectFileName());
    archiveProjectToLibrary(project);
    // The user now holds a canonical copy of this work on disk, so the
    // in-browser autosave is no longer the safety net — clear it so the
    // next launch does not offer a stale restore.
    if (typeof clearAutosave === 'function') clearAutosave();
    showToast('Project saved. Reopen it later with Open Project.');
  }

  function archiveProjectToLibrary(snapshot) {
    if (typeof addLibraryEntry !== 'function') return;
    const styleId = (snapshot && snapshot.state && typeof snapshot.state.styleId === 'string')
      ? snapshot.state.styleId.trim()
      : '';
    Promise.resolve()
      .then(() => addLibraryEntry({ styleId, snapshot }))
      .catch(err => {
        console.warn('Could not archive project to library:', err);
      });
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
    // Silence autosave while we rewrite state in bulk; any edit after
    // load completes will re-arm it via pushHistoryIfChanged. Wrapped
    // in try/finally so autosave always resumes even on a failed load.
    if (typeof suspendAutosave === 'function') suspendAutosave();
    try {
      const s = project.state;

      state.annotations = clone(s.annotations || []);
      state.annotations.forEach(ensureCurveControls);
      state.eraseStrokes = clone(s.eraseStrokes || []);
      state.brushSize = s.brushSize || 24;
      state.showLabels = s.showLabels !== false;
      state.calibration = s.calibration || { unitsPerPx: null, unit: 'in' };
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
      // Reopen behavior: a project that contains applied lines opens in
      // Manual Mode, ready to edit. An empty or image-only project stays
      // Auto-first so detection can run right away.
      state.appMode = state.annotations.length > 0 ? 'manual' : 'auto';
      state.autoMode = makeInitialAutoModeState();
      state.hiddenAnnIds = [];
      state.hiddenDraftIds = [];
      document.body.classList.toggle('app-auto', state.appMode === 'auto');
      document.body.classList.remove('tool-eraser');
      el.labelEditor.style.display = 'none';

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
