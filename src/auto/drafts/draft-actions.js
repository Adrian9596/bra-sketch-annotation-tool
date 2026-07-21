// TD review actions on drafts: approve, mark review-only, apply
// approved set atomically, discard, and reset working board.
// Source part for app.js. Run `npm run build` after editing.
//
// applyApprovedDraftsAtomically is the only path that mutates
// state.annotations during Auto Mode. It refuses to apply a partial
// approved set (atomic = all-or-nothing) so the audit trail stays clean.

  // -------- TD review actions on drafts --------

  function markDraftTouchedByTD(ann) {
    if (!isAutoDraft(ann)) return;
    const wasEdited = !!ann.tdEdited;
    ann.tdEdited = true;
    ann.tdApprovalRequired = true;
    ann.endpointApproximate = true;
    ann.tdApproved = false;
    ann.approvedAt = null;
    if (!wasEdited) {
      recordAutoTelemetryEvent('draft_edited', {
        sourceImageId: ann.sourceImageId,
        draft_id: ann.id,
        pom_id: ann.seq != null ? String(ann.seq) : (ann.text != null ? String(ann.text) : null),
      });
    }
  }

  function approveDraftAnnotation(ann) {
    if (!isAutoDraft(ann)) return;
    if (isReviewOnlyDraft(ann)) {
      showToast('REVIEW_ONLY rows cannot be approved.');
      return;
    }
    if (!ann.start || !ann.end) {
      showToast('This draft has no valid geometry.');
      return;
    }
    ann.tdApproved = true;
    ann.tdApprovalRequired = false;
    ann.endpointApproximate = false;
    ann.approvedAt = new Date().toISOString();
    recordAutoTelemetryEvent('draft_approved', {
      sourceImageId: ann.sourceImageId,
      draft_id: ann.id,
      pom_id: ann.seq != null ? String(ann.seq) : (ann.text != null ? String(ann.text) : null),
    });
  }

  function markDraftReviewOnly(ann) {
    if (!isAutoDraft(ann)) return;
    ann.drawability = 'REVIEW_ONLY';
    ann.start = null;
    ann.end = null;
    ann.control1 = null;
    ann.control2 = null;
    ann.label = null;
    ann.confidence = 'low';
    ann.tdEdited = true;
    ann.tdApproved = false;
    ann.tdApprovalRequired = true;
    ann.endpointApproximate = false;
    ann.approvedAt = null;
    if (!ann.uncertainty) ann.uncertainty = 'Marked REVIEW_ONLY by TD.';
    recordAutoTelemetryEvent('draft_review_only', {
      sourceImageId: ann.sourceImageId,
      draft_id: ann.id,
      pom_id: ann.seq != null ? String(ann.seq) : (ann.text != null ? String(ann.text) : null),
    });
  }

  // -------- Apply / Discard --------

  function applyApprovedDraftsAtomically(options = {}) {
    if (state.appMode !== 'auto') return false;
    const drafts = state.autoMode.draftAnnotations;
    const approved = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d));
    if (approved.length === 0) {
      showToast('No approved drafts to apply.');
      return false;
    }

    state.autoMode.status = 'applying';
    recordAutoTelemetryEvent('apply_started', {
      sourceImageId: approved[0] && approved[0].sourceImageId,
      approved_count: approved.length,
    });
    updateUI();

    // Atomic validation: every approved draft must still be drawable and
    // must not collide with an already-applied POM on the same source.
    // Key on `seq` first (drafts intentionally leave `text` null and rely on
    // the sequence number for the POM label) so multiple null-text drafts
    // never look like the same POM during apply.
    const geometryErrors = [];
    const duplicates = []; // { pomLabel, sourceImageId }
    const pomKeyOf = (ann) => {
      const seq = ann.seq != null ? String(ann.seq) : null;
      const text = ann.text != null && String(ann.text).trim() !== '' ? String(ann.text) : null;
      const label = seq || text || '?';
      return `${ann.sourceImageId || ''}|${label}`;
    };
    const existingAutoApplied = state.annotations.filter(a => isAutoDraft(a));
    const usedPomKeys = new Set(existingAutoApplied.map(pomKeyOf));

    for (const draft of approved) {
      const pomLabel = getLabelText(draft);
      if (!draft.start || !draft.end) {
        geometryErrors.push(`POM ${pomLabel}: missing geometry.`);
        continue;
      }
      if (!isFinitePoint(draft.start) || !isFinitePoint(draft.end)) {
        geometryErrors.push(`POM ${pomLabel}: non-finite coordinates.`);
        continue;
      }
      if (draft.type === 'curved' && (!isFinitePoint(draft.control1) || !isFinitePoint(draft.control2))) {
        geometryErrors.push(`POM ${pomLabel}: curve controls are invalid.`);
        continue;
      }
      const key = pomKeyOf(draft);
      if (usedPomKeys.has(key)) {
        duplicates.push({ pomLabel, sourceImageId: draft.sourceImageId || '', key });
        continue;
      }
      usedPomKeys.add(key);
    }

    // Duplicate-only conflict path: collapse the 16 repeated messages into a
    // single line, and offer to clear the existing auto-applied rows so the
    // user can recover instead of hitting Discard Drafts and starting over.
    if (duplicates.length && !geometryErrors.length) {
      // Replace ONLY the existing auto-applied rows that a new approved draft
      // actually duplicates (same POM key), NOT every auto line on the image.
      // Removing all of them and re-applying only the currently-approved drafts
      // silently dropped previously-applied POMs the TD didn't re-approve this
      // round (P1). Keying on the exact duplicate keys makes this a true 1:1
      // replace, so the dialog count equals what is removed.
      const collidingKeys = new Set(duplicates.map(d => d.key));
      const collidingExisting = existingAutoApplied.filter(a =>
        collidingKeys.has(pomKeyOf(a)));
      const summary = `Apply blocked — ${duplicates.length} POM${duplicates.length === 1 ? '' : 's'} already exist on this image.`;
      state.autoMode.status = 'error';
      state.autoMode.lastError = `${summary} Clear existing Auto-applied lines first, or use Discard Drafts.`;

      const canRecover = !options.suppressPrompt && collidingExisting.length > 0;
      const wantsClear = canRecover && window.confirm(
        `${summary}\n\nReplace the ${collidingExisting.length} existing Auto-applied line${collidingExisting.length === 1 ? '' : 's'} on this image with the new drafts?`
      );
      if (wantsClear) {
        const removeIds = new Set(collidingExisting.map(a => a.id));
        state.annotations = state.annotations.filter(a => !removeIds.has(a.id));
        if (state.selection.kind === 'annotation' && removeIds.has(state.selection.id)) {
          state.selection = { kind: null, id: null };
        }
        state.autoMode.lastError = null;
        // Re-run with suppressPrompt so we never recurse if something is left.
        return applyApprovedDraftsAtomically({ suppressPrompt: true });
      }

      showToast('Apply blocked — existing Auto-applied rows on this image.', 4200);
      console.warn('[Auto Mode] Apply blocked by ' + duplicates.length + ' duplicate(s).');
      updateUI();
      return false;
    }

    const errors = geometryErrors.concat(
      duplicates.map(d => `POM ${d.pomLabel}: another Auto-applied row already exists for this image.`)
    );
    if (errors.length) {
      state.autoMode.status = 'error';
      state.autoMode.lastError = errors.join('\n');
      showToast('Apply aborted — nothing changed. See status.', 4200);
      console.warn('[Auto Mode] Apply failed:\n' + errors.join('\n'));
      updateUI();
      return false;
    }

    // Atomic commit. Build the applied set first, then mutate state once.
    const applied = approved.map((draft) => buildAppliedAnnotation(draft));
    const sameImageAutoLines = state.annotations.filter(a =>
      isAutoDraft(a) && applied.some(next => next.sourceImageId === a.sourceImageId));
    nudgeAutoLabelsToAvoidCollisions(sameImageAutoLines.concat(applied));

    // Commit.
    for (const ann of applied) {
      state.annotations.push(ann);
      recordAutoTelemetryEvent('draft_applied', {
        sourceImageId: ann.sourceImageId,
        draft_id: ann.originDraftId,
        pom_id: ann.seq != null ? String(ann.seq) : (ann.text != null ? String(ann.text) : null),
      });
    }
    recordAutoAcceptanceStats(applied);
    // Remove the applied drafts from the draft layer (matched by id).
    const appliedDraftIds = new Set(approved.map(d => d.id));
    state.autoMode.draftAnnotations = drafts.filter(d => !appliedDraftIds.has(d.id));
    // Drop stale hide-toggles for drafts that no longer exist. New committed
    // annotations use fresh ids (see idCounter) so nothing carries over —
    // applied POM lines start visible by default.
    if (Array.isArray(state.hiddenDraftIds) && state.hiddenDraftIds.length > 0) {
      state.hiddenDraftIds = state.hiddenDraftIds.filter(id => !appliedDraftIds.has(id));
    }

    // Adjust selection if it pointed at one of the applied drafts.
    if (state.selection.kind === 'draft' && appliedDraftIds.has(state.selection.id)) {
      state.selection = { kind: null, id: null };
    }

    state.nextSequence = Math.max(
      state.nextSequence,
      state.annotations.reduce((m, a) => Math.max(m, (a.seq || 0) + 1), state.nextSequence),
    );

    state.autoMode.status = state.autoMode.draftAnnotations.length > 0 ? 'reviewing' : 'ready';
    // Lines are committed — hide the anchor pins so the applied POM lines
    // are readable. Detect / Reset Anchors show them again.
    state.autoMode.anchorsHidden = true;
    state.autoMode.anchorSelectedId = null;
    state.autoMode.lastError = null;
    recordAutoTelemetryEvent('apply_finished', {
      sourceImageId: applied[0] && applied[0].sourceImageId,
      count: applied.length,
      status: 'ok',
    });
    recordAutoTelemetryEvent('auto_session_done', {
      sourceImageId: applied[0] && applied[0].sourceImageId,
      count: applied.length,
      status: 'applied',
    });

    pushHistoryIfChanged();
    // Handoff: Apply means "review is done" — switch straight to Manual
    // Mode so the TD can edit the applied lines immediately. Any rows left
    // in the draft layer (REVIEW_ONLY audit rows, unapproved drafts) stay
    // there untouched; the Auto toggle brings them back into view.
    setAppMode('manual');
    updateUI();
    requestRender();
    showToast(`Applied ${applied.length} approved line${applied.length === 1 ? '' : 's'}.`);
    return true;
  }

  function buildAppliedAnnotation(draft) {
    const ann = {
      id: createUniqueAnnotationId(),
      seq: draft.seq,
      type: draft.type,
      style: draft.style,
      color: draft.color,
      arrowType: draft.arrowType,
      lineWidth: normalizeLineWidth(draft.lineWidth),
      start: clonePoint(draft.start),
      end: clonePoint(draft.end),
      midPoint: draft.midPoint ? clonePoint(draft.midPoint) : null,
      control1: draft.control1 ? clonePoint(draft.control1) : null,
      control2: draft.control2 ? clonePoint(draft.control2) : null,
      label: clonePoint(draft.label || computeDefaultLabelPosition(draft)),
      labelManual: !!draft.labelManual,
      text: draft.text,
      desc: draft.desc,
      value: draft.value,
      // Preserved Auto Mode metadata for save/reopen.
      auto: true,
      sourceMode: 'auto-mode',
      sourceImageId: draft.sourceImageId,
      autoRunId: draft.autoRunId,
      templateVersion: draft.templateVersion,
      ruleVersion: draft.ruleVersion,
      drawability: draft.drawability,
      confidence: draft.confidence,
      tdEdited: !!draft.tdEdited,
      acceptedWithoutEdit: !draft.tdEdited,
      acceptedTrackedAt: new Date().toISOString(),
      tdApproved: true,
      tdApprovalRequired: false,
      endpointApproximate: false,
      approvedAt: draft.approvedAt || new Date().toISOString(),
      proposedStartLandmark: draft.proposedStartLandmark || null,
      proposedEndLandmark: draft.proposedEndLandmark || null,
      reason: draft.reason || null,
      uncertainty: draft.uncertainty || null,
      sharedAnchorFamily: draft.sharedAnchorFamily || null,
      viewRole: draft.viewRole || effectivePomViewRole(draft.seq),
      originDraftId: draft.id,
    };
    ensureCurveControls(ann);
    return ann;
  }

  function isFinitePoint(p) {
    return !!(p && Number.isFinite(p.x) && Number.isFinite(p.y));
  }

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
    state.deletedAutoAnnotations = [];
    state.images = [];
    state.eraseStrokes = [];
    state.nextSequence = 1;
    state.selection = { kind: null, id: null };
    state.drawSession = null;
    state.eraseSession = null;
    state.interaction = null;
    state.editingLabelId = null;
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
