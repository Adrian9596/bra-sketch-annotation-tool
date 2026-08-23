// Save a .json project file: serialize, write to disk, archive to the
// library. Opening a saved file is project-load.js.
// Source part for app.js. Run `npm run build` after editing.
//
// buildProjectSnapshot serializes board state into the on-disk project
// format. Unapplied Auto Mode drafts are never persisted; the save flow
// prompts the TD to apply, discard, or cancel before writing.

  function buildProjectSnapshot() {
    return {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      savedAt: new Date().toISOString(),
      state: {
        annotations: clone(state.annotations),
        graphics: clone(state.graphics || []),
        images: state.images.map(img => ({
          id: img.id, dataURL: img.dataURL,
          x: img.x, y: img.y, width: img.width, height: img.height,
          locked: !!img.locked,
        })),
        eraseStrokes: clone(state.eraseStrokes),
        // US-092: Board text notes. Additive — files saved before US-092 have
        // no key and open with an empty note list.
        notes: clone(state.notes || []),
        brushSize: state.brushSize,
        showLabels: state.showLabels,
        calibration: clone(state.calibration),
        nextSequence: state.nextSequence,
        idCounter: state.idCounter,
        drawStyle: state.drawStyle,
        drawColor: state.drawColor,
        arrowType: state.arrowType,
        lineWidth: state.lineWidth,
        noteFontSize: state.noteFontSize,
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
        // US-068: MAIN PAGE sheet. Additive — files saved before US-068 have
        // no key and seed a default on open. US-080: the serializer injects
        // the version-sketch bytes, which live outside state.mainPage.
        mainPage: (typeof mpSerializeForProject === 'function')
          ? mpSerializeForProject()
          : (state.mainPage ? clone(state.mainPage) : null),
        // US-070: Construction annotation page. Additive — files saved
        // before US-070 have no key and seed a default on open.
        construction: (typeof ccSerializeForProject === 'function')
          ? ccSerializeForProject()
          : (state.construction ? clone(state.construction) : null),
        // US-072: BOM page. Additive — files saved before US-072 have no
        // key and seed a default (empty BOM) on open.
        bom: (typeof bmSerializeForProject === 'function')
          ? bmSerializeForProject()
          : (state.bom ? clone(state.bom) : null),
        // US-079: Preview & Export page-inclusion checkboxes. Additive —
        // files saved before US-079 have no key and default to all enabled.
        preview: state.preview ? clone(state.preview) : null,
      },
    };
  }

  function saveProject() {
    if (typeof hasUnsavedWork === 'function' ? !hasUnsavedWork() : (!state.annotations.length && !state.images.length)) {
      showToast('Nothing to save yet. Add or edit Board/BOM work first.');
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
