// Whole-board destructive operations: discard the current Auto Mode drafts,
// wipe the working board (photos + lines + detection), or delete every line
// while keeping the photo.
// Source part for app.js. Run `npm run build` after editing.
//
// These four act on the whole board (state.images, state.eraseStrokes,
// state.calibration, state.autoMode as a whole), not on one draft — the
// single-draft TD review actions live in draft-actions.js and the apply
// pipeline in apply-drafts.js. resetWorkingBoard and clearAllLinesKeepImage
// are asymmetric siblings (wipe-everything vs wipe-lines-only) and must stay
// behaviourally distinct.

  // -------- Discard / whole-board resets --------

  function discardAutoDrafts(silent) {
    if (state.autoMode.draftAnnotations.length === 0) return;
    if (!silent && !window.confirm('Discard all current Auto Mode drafts? Project annotations are not affected.')) return;
    const discardedCount = state.autoMode.draftAnnotations.length;
    const sourceImageId = state.autoMode.draftAnnotations[0] && state.autoMode.draftAnnotations[0].sourceImageId;
    state.autoMode.draftAnnotations = [];
    state.autoMode.validation = null;
    // Drafts are gone — any hide toggles that targeted them are stale.
    state.hiddenDraftIds = [];
    if (state.selection.kind === 'draft') {
      state.selection = { kind: null, id: null };
    }
    ensureAutoModeStatus();
    pushHistoryIfChanged();
    recordAutoTelemetryEvent('draft_discarded', {
      sourceImageId,
      count: discardedCount,
    });
    recordAutoTelemetryEvent('auto_session_done', {
      sourceImageId,
      count: discardedCount,
      status: 'discarded',
    });
    updateUI();
    requestRender();
    if (!silent) showToast('Drafts discarded. Project unchanged.');
  }

  function isWorkingBoardEmpty() {
    return state.images.length === 0
      && state.annotations.length === 0
      && (state.notes || []).length === 0
      && (state.graphics || []).length === 0
      && state.eraseStrokes.length === 0
      && state.autoMode.draftAnnotations.length === 0
      && !state.autoMode.detection;
  }

  // Wipe the working board so the TD can start a new bra sketch from scratch.
  // Images, lines, erase strokes, and any Auto Mode drafts/detection/anchors
  // all go away in one history step (so a single Undo brings them back).
  // imageDataById is intentionally NOT cleared — restoreSnapshot() reads
  // image pixels from there when Undo replays the prior snapshot.
  function resetWorkingBoard() {
    if (isWorkingBoardEmpty()) {
      showToast('Working board is already empty.');
      return;
    }
    if (!window.confirm('Reset the working board? This deletes all photos and lines so you can start a new bra sketch. Undo will bring them back.')) return;

    state.annotations = [];
    state.graphics = [];
    state.deletedAutoAnnotations = [];
    state.images = [];
    state.eraseStrokes = [];
    // US-092: notes are board content, so a whole-board reset takes them too.
    // clearAllLinesKeepImage deliberately does NOT — a note is not a line.
    state.notes = [];
    state.nextSequence = 1;
    state.selection = { kind: null, id: null };
    state.graphicEdit = null;
    state.drawSession = null;
    state.eraseSession = null;
    state.interaction = null;
    state.editingLabelId = null;
    discardNoteEditorSession();
    state.calibration = { unitsPerPx: null, unit: 'in' };
    state.autoMode = makeInitialAutoModeState();
    state.hiddenAnnIds = [];
    state.hiddenDraftIds = [];
    el.labelEditor.style.display = 'none';

    // Images going away invalidates every cached shadow detection.
    clearManualLearnCache();

    ensureAutoModeStatus();
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Working board reset. Ready for a new sketch.');
  }

  // Delete every POM line from the board — both applied annotations and any
  // current Auto Mode drafts — while KEEPING the sketch photo, detection, and
  // anchors, so the TD can re-tune and Generate again without re-adding the
  // image. This is the lighter counterpart to resetWorkingBoard() (which also
  // removes the photo). One history step: a single Undo restores the lines.
  // Bound to the D keyboard shortcut.
  function clearAllLinesKeepImage() {
    const hasLines = state.annotations.length > 0
      || state.autoMode.draftAnnotations.length > 0;
    if (!hasLines) {
      showToast('No lines to delete.');
      return;
    }

    state.annotations = [];
    state.deletedAutoAnnotations = [];
    state.autoMode.draftAnnotations = [];
    state.autoMode.validation = null;
    state.hiddenAnnIds = [];
    state.hiddenDraftIds = [];
    state.nextSequence = 1;
    if (state.selection.kind === 'annotation' || state.selection.kind === 'draft') {
      state.selection = { kind: null, id: null };
    }
    state.drawSession = null;
    state.editingLabelId = null;
    el.labelEditor.style.display = 'none';
    discardNoteEditorSession();

    // Lines are gone but the photo + detection remain — reveal the anchor
    // pins (they are hidden after an apply) so the board shows a clear next
    // step instead of a blank photo: re-tune anchors, then Generate.
    if (state.autoMode.detection) {
      state.autoMode.anchorsHidden = false;
    }

    ensureAutoModeStatus();
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('All lines deleted. Photo kept — Undo to restore.');
  }
