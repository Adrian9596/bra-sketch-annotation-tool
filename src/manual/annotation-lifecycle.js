// Destructive board-mutation lifecycle: deleteImageById (purges Auto Mode
// anchors/drafts/detection for a removed photo), deleteSelected, and
// clearAllAnnotations. Sibling files: annotation builders live in
// src/manual/annotation-factory.js; label-collision nudging lives in
// src/manual/label-layout.js; copy/paste/reflect lives in
// src/manual/annotation-clipboard.js.
// Source part for app.js. Run `npm run build` after editing.

  // Remove one image and purge everything tied to it (erase strokes, and in
  // Auto Mode its anchors / drafts / detection or aux view — US-052). Returns
  // true if an image was actually removed. Caller handles the lock check,
  // selection reset, history commit, and re-render.
  function deleteImageById(deletedId) {
    const before = state.images.length;
    state.images = state.images.filter(image => image.id !== deletedId);
    if (state.images.length === before) return false;
    state.eraseStrokes = state.eraseStrokes.filter(stroke => stroke.imageId !== deletedId);
    const am = state.autoMode;
    if (am) {
      am.anchors = (am.anchors || []).filter(a => a.sourceImageId !== deletedId);
      am.draftAnnotations = (am.draftAnnotations || []).filter(d => d.sourceImageId !== deletedId);
      if (am.anchorSelectedId != null && !am.anchors.some(a => a.id === am.anchorSelectedId)) am.anchorSelectedId = null;
      if (am.detection) {
        if (am.detection.sourceImageId === deletedId) am.detection = null;
        else if (Array.isArray(am.detection.auxViews)) {
          am.detection.auxViews = am.detection.auxViews.filter(v => v.sourceImageId !== deletedId);
        }
      }
      if (typeof ensureAutoModeStatus === 'function') ensureAutoModeStatus();
    }
    return true;
  }

  function deleteSelected() {
    if (state.selection.kind == null) return;

    if (state.selection.kind === 'annotation') {
      // US-093 / ADR 0053: Delete/Backspace with an interior anchor active
      // (the TD just clicked/Tab-cycled to it) removes just that anchor, not
      // the whole line — Delete with no interior anchor active falls through
      // to the whole-line delete below, unchanged. Single-selection only,
      // matching every other handle-level gesture in this file.
      const anchor = getSelectedAnnotationIds().length <= 1
        ? parseCurveAnchorPart(state.selection.part) : null;
      const anchorAnn = anchor ? getAnnotationById(state.selection.id) : null;
      if (anchor && anchorAnn && anchorAnn.type === 'curved'
          && Array.isArray(anchorAnn.points) && anchorAnn.points[anchor.index]) {
        deleteCurveAnchorAt(anchorAnn, anchor.index);
        state.selection.part = null;
        if (!anchorAnn.labelManual) anchorAnn.label = computeDefaultLabelPosition(anchorAnn);
        if (isAutoDraft(anchorAnn)) markDraftTouchedByTD(anchorAnn);
        pushHistoryIfChanged();
        updateUI();
        requestRender();
        return;
      }
      // Delete every selected line (Shift+click / marquee group).
      const ids = getSelectedAnnotationIds();
      if (!ids.length) return;
      const targets = ids.map(id => state.annotations.find(a => a.id === id)).filter(Boolean);
      const idSet = new Set(ids);
      const before = state.annotations.length;
      state.annotations = state.annotations.filter(a => !idSet.has(a.id));
      if (state.annotations.length === before) return;
      if (!Array.isArray(state.deletedPomKeys)) state.deletedPomKeys = [];
      for (const ann of targets) {
        // POM numbers are measurement identities, not list positions. Deleting
        // POM 7 must leave a gap instead of turning POM 8 into POM 7.
        if (typeof markDeletedAutoAnnotationForEvidence === 'function') markDeletedAutoAnnotationForEvidence(ann);
        // US-047: deleting a POM line excludes that POM from the exported spec,
        // exactly like the review × Hide toggle (TD: "delete = hide"). The id is
        // gone after this, so remember the POM label; the export drops the row
        // unless a line with that label is later redrawn.
        const label = String(getLabelText(ann));
        if (label && !state.deletedPomKeys.includes(label)) state.deletedPomKeys.push(label);
      }
    } else if (state.selection.kind === 'note') {
      // US-092: a note is drawing content, not a measurement. Nothing to record
      // in deletedPomKeys, no evidence entry, no exported row to keep in sync —
      // the whole point of keeping notes out of state.annotations.
      const before = (state.notes || []).length;
      state.notes = (state.notes || []).filter(note => note.id !== state.selection.id);
      if (state.notes.length === before) return;
    } else if (state.selection.kind === 'image') {
      // Delete every selected photo (Cmd/Ctrl+click group), skipping locked
      // ones. US-052: deleteImageById purges each photo's Auto Mode state.
      const targets = getSelectedImageIds().map(getImageById).filter(Boolean);
      const unlocked = targets.filter(im => !im.locked);
      const lockedCount = targets.length - unlocked.length;
      if (!unlocked.length) {
        showToast(lockedCount ? 'Image is locked. Click Unlock first.' : 'Select an image first.');
        return;
      }
      let deletedAny = false;
      for (const im of unlocked) { if (deleteImageById(im.id)) deletedAny = true; }
      if (!deletedAny) return;
      if (lockedCount) {
        showToast(lockedCount + ' locked photo' + (lockedCount > 1 ? 's' : '') + ' kept — unlock to delete.');
      }
    }

    state.selection = { kind: null, id: null };
    state.selectedImageIds = [];
    state.selectedAnnotationIds = [];
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  // US-092 step 6: remove ONE arrow from a note, leaving the note and its other
  // arrows alone. Delete on a selected note removes the whole note; this is the
  // finer gesture — double-click the arrow's tip — and follows the Construction
  // page's precedent, where double-clicking a callout's anchor deletes just that
  // leader line (ADR 0040). Returns true when something was removed.
  function removeNoteLeader(note, index) {
    if (!note || !Array.isArray(note.leaders)) return false;
    if (!Number.isInteger(index) || index < 0 || index >= note.leaders.length) return false;
    note.leaders.splice(index, 1);
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    return true;
  }

  function clearAllAnnotations() {
    if (!state.annotations.length) return;
    state.annotations = [];
    state.deletedAutoAnnotations = [];
    state.deletedPomKeys = [];
    state.nextSequence = 1;
    if (state.selection.kind === 'annotation') {
      state.selection = { kind: null, id: null };
    }
    state.drawSession = null;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }
