// History snapshots, undo/redo, restore-snapshot.
// Source part for app.js. Run `npm run build` after editing.
//
// Snapshots store annotation/image/calibration state by reference and image
// pixel data by id (looked up via imageDataById), so the undo stack stays
// small. Restore is async because images need to be reloaded into HTMLImage
// elements before rendering can resume.

  function seedHistory() {
    const snap = makeSnapshot();
    state.history.past = [{ snapshot: snap, fingerprint: snapshotFingerprint(snap) }];
    state.history.future = [];
  }

  function makeSnapshot() {
    // US-125: geometry can change through many established drag/nudge/resize
    // paths. Refresh the two Seam Path fingerprints at the shared snapshot
    // boundary so none of those paths can persist stale approval evidence.
    if (typeof seamPathRefreshAllFingerprints === 'function') seamPathRefreshAllFingerprints();
    return {
      tool: state.tool,
      drawStyle: state.drawStyle,
      drawColor: state.drawColor,
      arrowType: state.arrowType,
      lineWidth: state.lineWidth,
      noteFontSize: state.noteFontSize,
      noteAppearance: state.noteAppearance,
      noteTextColor: state.noteTextColor,
      noteLeaderColor: state.noteLeaderColor,
      annotations: clone(state.annotations),
      // ADR 0070: without this, undoing a Pattern Pieces "Remove unchecked"
      // restores the deleted annotations but leaves their block-name labels
      // gone — the panel would show a positional "Piece N" fallback for a
      // piece that still has a real name.
      templateGroupLabels: clone(state.templateGroupLabels || {}),
      // US-124 Phase 3: same reasoning as the labels — undo of a removal
      // must bring the piece's classification/annotation back with it.
      templateGroupMeta: clone(state.templateGroupMeta || {}),
      // ADR 0071.
      notches: clone(state.notches || []),
      graphics: clone(state.graphics || []),
      images: state.images.map(stripImageForSnapshot),
      eraseStrokes: clone(state.eraseStrokes),
      notes: clone(state.notes || []),
      nextSequence: state.nextSequence,
      selection: clone(state.selection),
      idCounter: state.idCounter,
      calibration: clone(state.calibration),
      pomSpecs: clone(state.pomSpecs || {}),
      gradeRules: clone(state.gradeRules || {}),
      customPoms: clone(state.customPoms || []),
      deletedPomKeys: clone(state.deletedPomKeys || []),
      mainPage: state.mainPage ? clone(state.mainPage) : null,
      construction: state.construction ? clone(state.construction) : null,
      bom: state.bom ? clone(state.bom) : null,
      preview: state.preview ? clone(state.preview) : null,
      // Auto Mode working state. Carried ONLY while Auto is the active mode, so
      // Manual undo/redo behaves exactly as before (every snapshot simply gains
      // the same `autoMode: null` key, and fingerprints are only ever compared
      // with each other).
      //
      // Without this an anchor correction was outside history entirely: the
      // fingerprint never changed, so pushHistoryIfChanged short-circuited and
      // Ctrl/Cmd+Z did nothing at all while the Undo button stayed enabled —
      // measured, a 0.074 drag survived two presses. The only way back was
      // "Reset Anchors", which throws away EVERY correction rather than the last
      // one. Drafts ride along because they are derived from the anchors: undoing
      // the anchor without them would put the board straight back into the
      // "line disagrees with its pins" state the re-sync exists to prevent.
      autoMode: state.appMode === 'auto' ? {
        anchors: clone(state.autoMode.anchors || []),
        drafts: clone(state.autoMode.draftAnnotations || []),
        anchorSelectedId: state.autoMode.anchorSelectedId != null
          ? state.autoMode.anchorSelectedId : null,
        status: state.autoMode.status || null,
      } : null,
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
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
  }

  async function restoreSnapshot(snapshot) {
    state.history.restoring = true;
    state.tool = snapshot.tool || 'select';
    state.drawStyle = snapshot.drawStyle || 'solid';
    state.drawColor = snapshot.drawColor || 'red';
    state.arrowType = snapshot.arrowType || 'double';
    state.lineWidth = normalizeLineWidth(snapshot.lineWidth);
    state.noteFontSize = normalizeNoteFontSize(snapshot.noteFontSize);
    state.noteAppearance = normalizeNoteAppearance(snapshot.noteAppearance);
    state.noteTextColor = normalizeColorKey(snapshot.noteTextColor || 'black');
    state.noteLeaderColor = normalizeColorKey(snapshot.noteLeaderColor || 'red');
    state.annotations = clone(snapshot.annotations || []);
    state.annotations.forEach(ensureCurveControls);
    state.annotations.forEach(ann => {
      if (ann && ann.seamPath) normalizeSeamPathAnnotation(ann);
    });
    state.templateGroupLabels = (snapshot.templateGroupLabels && typeof snapshot.templateGroupLabels === 'object')
      ? clone(snapshot.templateGroupLabels) : {};
    state.templateGroupMeta = (snapshot.templateGroupMeta && typeof snapshot.templateGroupMeta === 'object')
      ? clone(snapshot.templateGroupMeta) : {};
    state.notches = (snapshot.notches || []).map(normalizeNotch).filter(Boolean);
    state.graphics = normalizeBoardGraphics(snapshot.graphics || []);
    state.graphicEdit = null;
    state.eraseStrokes = clone(snapshot.eraseStrokes || []);
    state.notes = (snapshot.notes || []).map(normalizeNote).filter(Boolean);
    state.nextSequence = snapshot.nextSequence || (state.annotations.length + 1);
    state.selection = snapshot.selection || { kind: null, id: null };
    state.idCounter = snapshot.idCounter || inferNextIdCounter();
    state.calibration = snapshot.calibration || { unitsPerPx: null, unit: 'in' };
    state.pomSpecs = clone(snapshot.pomSpecs || {});
    // migrate defensively: history is session-only, but a snapshot taken by
    // pre-US-011 code (or with a legacy depthRules field) must still restore.
    state.gradeRules = migrateGradeRulesV2(snapshot.gradeRules, snapshot.depthRules);
    state.customPoms = clone(snapshot.customPoms || []);
    state.deletedPomKeys = clone(snapshot.deletedPomKeys || []);
    state.mainPage = snapshot.mainPage ? clone(snapshot.mainPage) : null;
    if (typeof renderMainPage === 'function') renderMainPage();
    state.construction = snapshot.construction ? clone(snapshot.construction) : null;
    if (typeof renderConstruction === 'function') renderConstruction();
    state.bom = snapshot.bom ? clone(snapshot.bom) : null;
    if (typeof renderBom === 'function') renderBom();
    state.preview = snapshot.preview ? clone(snapshot.preview) : null;
    if (state.activePage === 'preview' && typeof renderPreviewPage === 'function') renderPreviewPage();
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
    if (state.selection.kind === 'note' && !state.notes.some(n => n.id === state.selection.id)) {
      state.selection = { kind: null, id: null };
    }
    if (state.selection.kind === 'notch' && !state.notches.some(n => n.id === state.selection.id)) {
      state.selection = { kind: null, id: null };
    }

    // Auto Mode working state — mirror of makeSnapshot. Restored only while Auto
    // is active: a snapshot taken in Auto that is restored after the Apply-Lines
    // handoff must not resurrect anchors into a Manual board.
    if (state.appMode === 'auto' && snapshot.autoMode) {
      state.autoMode.anchors = clone(snapshot.autoMode.anchors || []);
      state.autoMode.draftAnnotations = clone(snapshot.autoMode.drafts || []);
      state.autoMode.draftAnnotations.forEach(ensureCurveControls);
      if (snapshot.autoMode.status) state.autoMode.status = snapshot.autoMode.status;
      const selectedAnchorId = snapshot.autoMode.anchorSelectedId;
      state.autoMode.anchorSelectedId =
        state.autoMode.anchors.some(a => a.id === selectedAnchorId) ? selectedAnchorId : null;
      if (state.selection.kind === 'draft'
          && !state.autoMode.draftAnnotations.some(d => d.id === state.selection.id)) {
        state.selection = { kind: null, id: null };
      }
    }

    // The source itself is not generic history data. Never leave its native
    // topology attached if Undo/Redo restored incompatible board geometry.
    if (state.dxfPatternSource && !dxfPatternSourceIsCompatible(state.dxfPatternSource)) {
      invalidateDxfPatternSource(
        'Pattern Measure cleared because Undo/Redo changed its DXF geometry. Reopen the DXF to measure again.'
      );
    }

    state.history.restoring = false;
    updateUI();
    requestRender();
    if (typeof scheduleAutosave === 'function') scheduleAutosave();
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
